import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash, createHmac } from "crypto";

const ACCESS_ID = process.env.TUYA_ACCESS_ID;
const ACCESS_SECRET = process.env.TUYA_ACCESS_SECRET;
const BASE_URL = "https://openapi.tuyaeu.com";
const BUCKET_NAME = process.env.TUYA_BUCKET_NAME;
const KEY_STORAGE = {
  token: "cache-token.json",
  categories: "cache-categories.json",
};
const UID = process.env.TUYA_UID;
const ABORT_TIMEOUT_MS = 10000;
const TOKEN_REFRESH_BUFFER_MS = 60000;

const s3Client = new S3Client({
  region: "ru-central1",
  endpoint: "https://storage.yandexcloud.net",
});

let cacheToken = null;
let cacheCategories = null;

function throwError(name, message) {
  const error = new Error(message);
  error.name = name;
  throw error;
}

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

function hmacSha256(str, secret) {
  return createHmac("sha256", secret)
    .update(str, "utf8")
    .digest("hex")
    .toUpperCase();
}

function generateSignature({
  method,
  accessToken,
  t,
  body,
  signatureHeaders = "",
  url,
}) {
  const contentHash = sha256(body);
  const stringToSign = [method, contentHash, signatureHeaders, url].join("\n");
  const stringToHash = ACCESS_ID + accessToken + t + stringToSign;
  return hmacSha256(stringToHash, ACCESS_SECRET);
}

async function tuyaRequest({
  url,
  errorInfo,
  method = "GET",
  body = null,
  requireToken = true,
}) {
  if (requireToken) {
    await ensureToken();
  }

  const t = Date.now().toString();
  const payload = body === null ? "" : JSON.stringify(body);
  const accessToken = requireToken ? cacheToken.accessToken : "";
  const sign = generateSignature({
    method,
    accessToken,
    t,
    body: payload,
    url,
  });
  const options = {
    method,
    headers: {
      client_id: ACCESS_ID,
      sign,
      sign_method: "HMAC-SHA256",
      t,
      access_token: accessToken,
      "Content-Type": "application/json",
    },
    body: payload || undefined,
    signal: AbortSignal.timeout(ABORT_TIMEOUT_MS),
  };

  let response;

  try {
    response = await fetch(BASE_URL + url, options);
  } catch (error) {
    throwError("FetchError", `Can not ${errorInfo}. ${error.message}`);
  }

  if (!response.ok) {
    throwError(
      "FetchError",
      `Can not ${errorInfo}. Status code: ${response.status}, status text: ${response.statusText}`,
    );
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throwError("FetchError", `Can not ${errorInfo}. Invalid JSON in response`);
  }

  if (!data.success) {
    throwError("TuyaError", data.code);
  }

  return data;
}

async function readFromStorage(storageKey) {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: storageKey,
    });

    const response = await s3Client.send(command);
    const jsonString = await response.Body.transformToString();
    return JSON.parse(jsonString);
  } catch (error) {
    if (error.name === "NoSuchKey") {
      return null;
    }

    console.error(
      "StorageError",
      `Can not read data "${storageKey}" from Object Storage. ${error.message}`,
    );

    return null;
  }
}

async function writeToStorage(storageKey, data) {
  try {
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: storageKey,
      Body: JSON.stringify(data),
      ContentType: "application/json",
    });
    await s3Client.send(command);
  } catch (error) {
    console.error(
      "StorageError",
      `Can not write data "${storageKey}" to Object Storage. ${error.message}`,
    );
  }
}

async function ensureToken() {
  if (cacheToken === null) {
    cacheToken = await readFromStorage(KEY_STORAGE.token);
  }

  if (cacheToken !== null) {
    const expiredTime = cacheToken.issuedTime + cacheToken.expireTime * 1000;

    if (expiredTime - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
      return;
    }
  }

  const data = await tuyaRequest({
    url: `/v1.0/token?grant_type=1`,
    errorInfo: "get access token",
    requireToken: false,
  });

  cacheToken = {
    accessToken: data.result.access_token,
    issuedTime: data.t,
    expireTime: data.result.expire_time,
  };

  await writeToStorage(KEY_STORAGE.token, cacheToken);
}

async function ensureCategories() {
  if (cacheCategories === null) {
    cacheCategories = await readFromStorage(KEY_STORAGE.categories);
  }

  if (cacheCategories === null) {
    const data = await tuyaRequest({
      url: "/v1.0/iot-03/device-categories",
      errorInfo: "get category list",
    });

    const categories = data.result;

    cacheCategories = Object.fromEntries(
      categories.map(({ code, name }) => [code, name]),
    );

    await writeToStorage(KEY_STORAGE.categories, cacheCategories);
  }
}

async function getDeviceList() {
  const data = await tuyaRequest({
    url: `/v1.0/users/${UID}/devices`,
    errorInfo: "get device list",
  });

  await ensureCategories();

  for (let i = 0; i < data.result.length; i++) {
    data.result[i].category_title = cacheCategories[data.result[i].category];
  }

  return data.result;
}

async function getDeviceProperties(deviceId) {
  const data = await tuyaRequest({
    url: `/v2.0/cloud/thing/${deviceId}/shadow/properties`,
    errorInfo: "get device properties",
  });

  return data.result;
}

async function setDeviceStatus(deviceId, commands) {
  const data = await tuyaRequest({
    url: `/v1.0/devices/${deviceId}/commands`,
    errorInfo: "set status of device",
    method: "POST",
    body: commands,
  });

  return data.result;
}

async function setDeviceProperty(deviceId, properties) {
  const data = await tuyaRequest({
    url: `/v2.0/cloud/thing/${deviceId}/shadow/properties/issue`,
    errorInfo: "set property of device",
    method: "POST",
    body: properties,
  });

  return data.result;
}

function buildResponse({ statusCode = 200, body }) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  try {
    let body = {};
    if (event.body) {
      try {
        body =
          typeof event.body === "string" ? JSON.parse(event.body) : event.body;
      } catch {
        throwError("ValidationError", "Invalid JSON in request body");
      }
    }

    switch (event.path) {
      case "/device-list": {
        const devices = await getDeviceList();

        return buildResponse({
          body: devices,
        });
      }
      case "/device-properties": {
        const { deviceId } = body;
        const { properties } = await getDeviceProperties(deviceId);

        return buildResponse({
          body: properties,
        });
      }
      case "/set-property": {
        const { deviceId, code, value } = body;
        const properties = { properties: { [code]: value } };
        const result = await setDeviceProperty(deviceId, properties);

        return buildResponse({
          body: result,
        });
      }
      case "/set-status": {
        const { deviceId, code, value } = body;
        const commands = { commands: [{ code, value }] };
        const result = await setDeviceStatus(deviceId, commands);

        return buildResponse({
          body: result,
        });
      }
      default: {
        return buildResponse({
          statusCode: 404,
          body: {
            error: "NotFound",
            message: "The requested resource was not found",
          },
        });
      }
    }
  } catch (error) {
    console.error(error.message);

    switch (error.name) {
      case "ValidationError": {
        return buildResponse({
          statusCode: 400,
          body: {
            error: error.name,
            message: error.message,
          },
        });
      }
      case "TuyaError":
      case "FetchError": {
        return buildResponse({
          statusCode: 502,
          body: {
            error: error.name,
            message: error.message,
          },
        });
      }
      default: {
        return buildResponse({
          statusCode: 500,
          body: {
            error: "InternalError",
            message: error.message,
          },
        });
      }
    }
  }
};
