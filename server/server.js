import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PORT = 4000, TEST_COUNTRY = "MW" } = process.env;
const base = "https://api-m.sandbox.paypal.com";
const app = express();

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error("必要な PayPal の環境変数が設定されていません！");
  process.exit(1);
}

app.set("view engine", "ejs");
app.set("views", "./server/views");

// host static files
app.use(express.static("client"));
//app.use(express.static(path.join(__dirname, "public")));

// parse post params sent in body in json format
app.use(express.json());

import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

/**
 * 検証用の shipping address プリセット。
 * 参照: https://developer.paypal.com/api/rest/reference/orders/v2/country-address-requirements/
 *   - Malawi (MW): city=Required / postal_code=Optional
 *   - United States (US): city=Required / postal_code=Required
 *
 * .env の TEST_COUNTRY で切り替えられる。キー一覧:
 *   MW                      : postal_code 未設定・city あり            → 想定: 成功 (postal Optional)
 *   US                      : postal_code 未設定・city あり            → 想定: エラー POSTAL_CODE_REQUIRED
 *   US_VALID                : postal_code あり・city あり (正常系)      → 想定: 成功
 *   US_POSTAL_ONLY_NO_CITY  : postal_code あり・city は空文字/未設定    → city 必須が本当に強制されるか確認用
 *   US_POSTAL_GARBAGE_CITY  : postal_code あり・city はデタラメな文字列 → postal codeさえあれば city の中身は問われないか確認用
 *   MW_GARBAGE_CITY         : postal_code 未設定・city はデタラメな文字列 → Malawi 側でも city の中身チェックがあるか確認用
 */
const SHIPPING_ADDRESS_PRESETS = {
  MW: {
    address_line_1: "P.O. Box 123",
    admin_area_2: "Lilongwe",
    country_code: "MW",
    // postal_code はあえて未設定（Malawi の仕様検証用）
  },
  MW_GARBAGE_CITY: {
    address_line_1: "P.O. Box 123",
    admin_area_2: "Zzzznotarealcity999",
    country_code: "MW",
    // postal_code は未設定のまま、city にデタラメな値を入れて中身チェックの有無を見る
  },
  US: {
    address_line_1: "123 Main St",
    admin_area_2: "San Jose",
    admin_area_1: "CA",
    country_code: "US",
    // postal_code はあえて未設定（US の仕様検証用。US は Required のためエラーが想定される）
  },
  US_VALID: {
    address_line_1: "123 Main St",
    admin_area_2: "San Jose",
    admin_area_1: "CA",
    postal_code: "95131",
    country_code: "US",
    // 正常系（比較用ベースライン）
  },
  US_POSTAL_ONLY_NO_CITY: {
    address_line_1: "123 Main St",
    admin_area_2: "", // city を空文字にして送信（丸ごと省略したい場合はこのキー自体を消してください）
    admin_area_1: "CA",
    postal_code: "95131",
    country_code: "US",
  },
  US_POSTAL_GARBAGE_CITY: {
    address_line_1: "123 Main St",
    admin_area_2: "Zzzznotarealcity999", // 実在しない/郵便番号と整合しない city
    admin_area_1: "CAA",
    postal_code: "95131",
    country_code: "US",
  },
};

/**
 * Generate an OAuth 2.0 access token for authenticating with PayPal REST APIs.
 * @see https://developer.paypal.com/api/rest/authentication/
 */
const generateAccessToken = async () => {
  try {
    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
      throw new Error("MISSING_API_CREDENTIALS");
    }
    const auth = Buffer.from(
      PAYPAL_CLIENT_ID + ":" + PAYPAL_CLIENT_SECRET,
    ).toString("base64");
    const response = await fetch(`${base}/v1/oauth2/token`, {
      method: "POST",
      body: "grant_type=client_credentials",
      headers: {
        Authorization: `Basic ${auth}`,
      },
    });

    const data = await response.json();
    return data.access_token;
  } catch (error) {
    console.error("Failed to generate Access Token:", error);
  }
};

/**
 * Create an order to start the transaction.
 * @see https://developer.paypal.com/docs/api/orders/v2/#orders_create
 */
const createOrder = async (cart) => {
  // use the cart information passed from the front-end to calculate the purchase unit details
  console.log(
    "shopping cart information passed from the frontend createOrder() callback:",
    cart,
  );

  // フロントエンドから country が渡された場合はそれを優先、なければ .env の TEST_COUNTRY を使う
  const countryKey = (cart && cart.country) || TEST_COUNTRY;
  const shippingAddress =
    SHIPPING_ADDRESS_PRESETS[countryKey] || SHIPPING_ADDRESS_PRESETS.MW;

  console.log(
    `[shipping address test] country=${countryKey} address=`,
    shippingAddress,
  );

  const accessToken = await generateAccessToken();
  const url = `${base}/v2/checkout/orders`;
  const payload = {
    intent: "CAPTURE",
    purchase_units: [
      {
        amount: {
          currency_code: "USD",
          value: "1",
        },
        shipping: {
          name: {
            full_name: "Test Buyer",
          },
          address: shippingAddress,
        },
      },
    ],
    payment_source: {
      card: {
        attributes: {
          verification: {
              method: "SCA_ALWAYS",
          },
          vault: {
              store_in_vault: "ON_SUCCESS",
          }
        }
      }
    }
  };

  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      // Uncomment one of these to force an error for negative testing (in sandbox mode only). Documentation:
      // https://developer.paypal.com/tools/sandbox/negative-testing/request-headers/
      // "PayPal-Mock-Response": '{"mock_application_codes": "MISSING_REQUIRED_PARAMETER"}'
      // "PayPal-Mock-Response": '{"mock_application_codes": "PERMISSION_DENIED"}'
      // "PayPal-Mock-Response": '{"mock_application_codes": "INTERNAL_SERVER_ERROR"}'
    },
    method: "POST",
    body: JSON.stringify(payload),
  });

  return handleResponse(response);
};

/**
 * Capture payment for the created order to complete the transaction.
 * @see https://developer.paypal.com/docs/api/orders/v2/#orders_capture
 */
const captureOrder = async (orderID) => {
  const accessToken = await generateAccessToken();
  const url = `${base}/v2/checkout/orders/${orderID}/capture`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      // Uncomment one of these to force an error for negative testing (in sandbox mode only). Documentation:
      // https://developer.paypal.com/tools/sandbox/negative-testing/request-headers/
      // "PayPal-Mock-Response": '{"mock_application_codes": "INSTRUMENT_DECLINED"}'
      // "PayPal-Mock-Response": '{"mock_application_codes": "TRANSACTION_REFUSED"}'
      // "PayPal-Mock-Response": '{"mock_application_codes": "INTERNAL_SERVER_ERROR"}'
    },
  });

  return handleResponse(response);
};

async function handleResponse(response) {
  try {
    const jsonResponse = await response.json();
    return {
      jsonResponse,
      httpStatusCode: response.status,
    };
  } catch (err) {
    const errorMessage = await response.text();
    throw new Error(errorMessage);
  }
}

app.post("/api/orders", async (req, res) => {
  try {
    // use the cart information passed from the front-end to calculate the order amount detals
    const { cart } = req.body;
    const { jsonResponse, httpStatusCode } = await createOrder(cart);
    res.status(httpStatusCode).json(jsonResponse);
  } catch (error) {
    console.error("Failed to create order:", error);
    res.status(500).json({ error: "Failed to create order." });
  }
});

app.post("/api/orders/:orderID/capture", async (req, res) => {
  try {
    const { orderID } = req.params;
    const { jsonResponse, httpStatusCode } = await captureOrder(orderID);
    res.status(httpStatusCode).json(jsonResponse);
  } catch (error) {
    console.error("Failed to create order:", error);
    res.status(500).json({ error: "Failed to capture order." });
  }
});

// render checkout page with client id & unique client token
app.get("/", async (req, res) => {
  try {
    res.render("checkout", {
      clientId: PAYPAL_CLIENT_ID,
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Node server listening at http://localhost:${PORT}/`);
  console.log(`[shipping address test] TEST_COUNTRY=${TEST_COUNTRY} (.env で MW / US を切り替え可能)`);
});
