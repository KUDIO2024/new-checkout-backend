const express = require("express");
const dotenv = require("dotenv");
const stripe = require("stripe");
const crypto = require("crypto");

dotenv.config();
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const stripeInstance = stripe(STRIPE_SECRET_KEY);
const apiKey = process.env.API_KEY;
const resellerId = process.env.RESELLER_ID;
const domainTypes = ["co.uk", "com", "org", "org.uk", "uk"];

const app = express();
app.use(express.json());
const cors = require("cors");
app.use(cors());

const constants = {
  urls: {
    domainAvailability: "https://reseller-api.ds.network/domains/availability",
    domainResistrant: "https://reseller-api.ds.network/domains/registrants",
    getDomainList: "https://reseller-api.ds.network/domains",
    domainRegister: "https://reseller-api.ds.network/domains",
    customerRegister: "https://reseller-api.ds.network/customers",
    emailPackageRegister:
      "https://reseller-api.ds.network/products/email-hostings",
  },
};

let customerId = 0;

function generateRequestID() {
  return crypto
    .createHash("md5")
    .update(Date.now().toString() + Math.random().toString())
    .digest("hex");
}

function generateSignature(requestId, apiKey) {
  return crypto
    .createHash("md5")
    .update(requestId + apiKey)
    .digest("hex");
}

app.post("/create-payment-intent", async (req, res) => {
  // const totalPrice = req.body.totalPrice;
  const totalPrice = totalPrice;
  console.log(req.body);
  try {
    const paymentIntent = await stripeInstance.paymentIntents.create({
      amount: totalPrice * 100,
      currency: "gbp",
      payment_method: req.body.paymentMethodId,
      confirm: true,
      metadata: { country: "GB" },
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: "never",
      },
    });
    console.log(paymentIntent);

    if (paymentIntent.status === "requires_action") {
      res.json({
        clientSecret: paymentIntent.client_secret,
        transactionId: paymentIntent.id,
      });
    } else if (paymentIntent.status === "succeeded") {
      res.json({ payment_succeed: true, transactionId: paymentIntent.id });
    } else {
      res.json({ error: "Payment intent failed." });
    }
  } catch (error) {
    console.error(error);
    res.status(500).send({ error: error.message });
  }
});

app.get("/domain-availability", async (req, res) => {
  const domain = req.query.domain.toLowerCase();

  if (!domain) {
    return res.status(400).json({ error: "Domain name is required" });
  }

  try {
    console.log("start");
    const domainName = domain.split(".")[0];
    const requestId = generateRequestID();
    const signature = generateSignature(requestId, apiKey);
    console.log(requestId, signature);

    let url = constants.urls.domainAvailability + "?";

    const domainQueries = domainTypes.map(
      (type) => `domain_names[]=${domainName}.${type}`
    );
    url += domainQueries.join("&");
    url += "&currency=GBP";

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Api-Request-Id": requestId,
        "Api-Signature": signature,
        "Reseller-ID": resellerId,
        accept: "application/json",
      },
    });

    const data = await response.json();
    console.log(data);

    if (data && Array.isArray(data.data)) {
      res.status(200).json({ data: data.data });
    } else {
      res.status(200).json({ data: [] });
    }
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch domain availability" });
  }
});

app.post("/register-domain", async (req, res) => {
  const { domain, emailPlan, userDetails } = req.body;
  const registrantData = {
    first_name: userDetails.firstName || "",
    last_name: userDetails.lastName || "",
    address: userDetails.address.line1 || "",
    city: userDetails.address.city || "",
    state: userDetails.address.region || "",
    post_code: userDetails.address.postalCode || "",
    country: "GB",
    country_code: 44,
    phone: userDetails.phone || "",
    email: userDetails.email || "",
    account_type: "personal",
  };

  const registerCustomerResponse = await registerCustomer(registrantData);
  if (registerCustomerResponse.status) {
    customerId = registerCustomerResponse.data.id;
    const response = await registerDomain(domain, emailPlan, customerId);
    console.log("===========> register status and error ", response);
    res.json({ response, customerId });
  }
});

async function registerDomain(domain, emailPlan, customerId) {
  let plan_id = 0;
  switch (emailPlan) {
    case "basic":
      plan_id = 47;
      break;
    case "standard":
      plan_id = 48;
      break;
    case "premium":
      plan_id = 49;
      break;
    default:
      plan_id = 0;
      break;
  }
  const registerUrl = constants.urls.domainRegister;
  const emailHostingUrl = constants.urls.emailPackageRegister;

  const requestId = generateRequestID();
  const signature = generateSignature(requestId, apiKey);
  try {
    const domainResponse = await fetch(registerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accept: "application/json",
        "Api-Request-Id": requestId,
        "Api-Signature": signature,
      },
      body: JSON.stringify({
        domain_name: domain,
        customer_id: customerId,
        period: 12,
      }),
    });
    const domainData = await domainResponse.json();
    if (
      domainData.status &&
      (domainData.data.status_id == 1 || domainData.data.status_id == 2)
    ) {
      if (!plan_id) return { status: true, error: "" };

      const new_requestId = generateRequestID();
      const new_signature = generateSignature(new_requestId, apiKey);
      try {
        const emailHostingResponse = await fetch(emailHostingUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            accept: "application/json",
            "Api-Request-Id": new_requestId,
            "Api-Signature": new_signature,
          },
          body: JSON.stringify({
            domain_name: domain,
            plan_id: plan_id,
            customer_id: customerId,
            period: 12,
          }),
        });
        const emailHostingData = await emailHostingResponse.json();

        if (emailHostingData.status === true) {
          if (
            emailHostingData.data.status_id == 1 ||
            emailHostingData.data.status_id == 2
          ) {
            return { status: true, error: "" };
          } else
            return {
              status: false,
              error:
                "Succeeded to register domain but Failed to register email hosting. Please confirm if you provide right information.",
            };
        } else
          return {
            status: false,
            error:
              "Succeeded to register domain but Failed to register email hosting. " +
              emailHostingData.error_message,
          };
      } catch (error) {
        console.error("Error registering email hosting:", error);
        return {
          status: false,
          error:
            "Succeeded to register domain but Failed to register email hosting.",
        };
      }
    } else {
      return {
        status: false,
        error:
          "An error occured in registering domain and email hosting " +
          domainData.error_message,
      };
    }
  } catch (error) {
    console.error("Error registering domain:", error);
    return {
      status: false,
      error: "Failed to register domain and email hosting",
    };
  }
}

async function registerCustomer(registrantData) {
  const requestId = generateRequestID();
  const signature = generateSignature(requestId, apiKey);

  const customerUrl = constants.urls.customerRegister;

  try {
    const customerResponse = await fetch(customerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accept: "application/json",
        "Api-Request-Id": requestId,
        "Api-Signature": signature,
        "Reseller-ID": resellerId,
      },
      body: JSON.stringify(registrantData),
    });

    const customerResult = await customerResponse.json();

    if (customerResult.status) {
      console.log(
        "============> Customer registered successfully ",
        customerResult
      );
      return customerResult;
    } else {
      // throw new Error(customerResult.error_message);
      console.log(
        "============> Customer registration failed ",
        customerResult
      );
      return customerResult;
    }
  } catch (error) {
    console.error("Error registering customer:", error);
    throw new Error("Failed to register customer");
  }
}

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
