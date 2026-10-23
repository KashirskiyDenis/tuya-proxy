import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash, createHmac } from "crypto";

const REQUIRED_ENV_VARS = [
  "TUYA_ACCESS_ID",
  "TUYA_ACCESS_SECRET",
  "TUYA_BUCKET_NAME",
  "TUYA_UID",
];

const missingVars = REQUIRED_ENV_VARS.filter((v) => !process.env[v]);

if (missingVars.length > 0) {
  throwError(
    "DeployError",
    `Missing required environment variables: ${missingVars.join(", ")}`,
  );
}

const ACCESS_ID = process.env.TUYA_ACCESS_ID;
const ACCESS_SECRET = process.env.TUYA_ACCESS_SECRET;
const BUCKET_NAME = process.env.TUYA_BUCKET_NAME;
const UID = process.env.TUYA_UID;
const BASE_URL = "https://openapi.tuyaeu.com";
const KEY_STORAGE = {
  token: "cache-token.json",
  categories: "cache-categories.json",
};
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

  for (const device of data.result || []) {
    device.category_title = cacheCategories[device.category];
  }

  return data.result || [];
}

async function getDeviceProperties(deviceId) {
  const data = await tuyaRequest({
    url: `/v2.0/cloud/thing/${deviceId}/shadow/properties`,
    errorInfo: "get device properties",
  });

  return data.result;
}

async function setDeviceStatus(deviceId, code, value) {
  const commands = { commands: [{ code, value }] };
  const data = await tuyaRequest({
    url: `/v1.0/devices/${deviceId}/commands`,
    errorInfo: "set status of device",
    method: "POST",
    body: commands,
  });

  return data.result;
}

async function setDeviceProperty(deviceId, code, value) {
  const properties = { properties: { [code]: value } };

  const data = await tuyaRequest({
    url: `/v2.0/cloud/thing/${deviceId}/shadow/properties/issue`,
    errorInfo: "set property of device",
    method: "POST",
    body: properties,
  });

  return data.result;
}

async function getSignalStrength(deviceId, deviceType) {
  const data = await tuyaRequest({
    url: `/v2.0/cloud/thing/${deviceId}/${deviceType}/signal`,
    errorInfo: "get signal strength",
  });

  return data.result;
}

async function getUpdateInformation(deviceId) {
  const data = await tuyaRequest({
    url: `/v2.0/cloud/thing/${deviceId}/firmware`,
    errorInfo: "get firmware update info",
  });

  return data.result;
}

async function getUpdateProgress(deviceId, channel) {
  const data = await tuyaRequest({
    url: `/v2.0/cloud/thing/${deviceId}/firmware/${channel}/progress`,
    errorInfo: "get firmware update progress",
  });

  return data.result;
}

async function confirmStartUpdate(deviceId, channel) {
  const data = await tuyaRequest({
    url: `/v2.0/cloud/thing/${deviceId}/firmware/${channel}`,
    errorInfo: "confirm start update",
    method: "POST",
  });

  return data.result;
}

async function restoreFactoryDefaults(deviceId) {
  const data = await tuyaRequest({
    url: `/v2.0/cloud/thing/${deviceId}/reset`,
    errorInfo: "restore factory defaults",
    method: "POST",
  });

  return data.result;
}

async function getFreezeState(deviceId) {
  const data = await tuyaRequest({
    url: `/v2.0/cloud/thing/${deviceId}/state`,
    errorInfo: "get freeze state",
  });

  return data.result;
}

async function setFreezeState(deviceId, state) {
  const data = await tuyaRequest({
    url: `/v2.0/cloud/thing/${deviceId}/freeze`,
    errorInfo: "set freeze state",
    method: "POST",
    body: state,
  });

  return data.result;
}

async function deleteDevice(deviceId) {
  const data = await tuyaRequest({
    url: `/v2.0/cloud/thing/${deviceId}`,
    errorInfo: "delete device",
    method: "DELETE",
  });

  return data.result;
}

function requireField(body, field) {
  const value = body?.[field];
  if (value === "" || value === null || value === undefined) {
    throwError("ValidationError", `Field "${field}" is required`);
  }
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

const ROUTES = {
  "/get-devices": {
    method: "GET",
    handler: getDeviceList,
  },
  "/get-properties": {
    method: "GET",
    required: ["deviceId"],
    handler: ({ deviceId }) => getDeviceProperties(deviceId),
  },
  "/set-property": {
    method: "POST",
    required: ["deviceId", "code", "value"],
    handler: ({ deviceId, code, value }) =>
      setDeviceProperty(deviceId, code, value),
  },
  "/set-status": {
    method: "POST",
    required: ["deviceId", "code", "value"],
    handler: ({ deviceId, code, value }) =>
      setDeviceStatus(deviceId, code, value),
  },
  "/get-signal": {
    method: "GET",
    required: ["deviceId", "deviceType"],
    handler: ({ deviceId, deviceType }) =>
      getSignalStrength(deviceId, deviceType),
  },
  "/get-update-info": {
    method: "GET",
    required: ["deviceId"],
    handler: ({ deviceId }) => getUpdateInformation(deviceId),
  },
  "/get-update-progress": {
    method: "GET",
    required: ["deviceId", "channel"],
    handler: ({ deviceId, channel }) => getUpdateProgress(deviceId, channel),
  },
  "/start-update": {
    method: "POST",
    required: ["deviceId", "channel"],
    handler: ({ deviceId, channel }) => confirmStartUpdate(deviceId, channel),
  },
  "/restore-default": {
    method: "POST",
    required: ["deviceId"],
    handler: ({ deviceId }) => restoreFactoryDefaults(deviceId),
  },
  "/get-freeze": {
    method: "GET",
    required: ["deviceId"],
    handler: ({ deviceId }) => getFreezeState(deviceId),
  },
  "/set-freeze": {
    method: "POST",
    required: ["deviceId", "state"],
    handler: ({ deviceId, state }) => setFreezeState(deviceId, { state }),
  },
  "/delete-device": {
    method: "DELETE",
    required: ["deviceId"],
    handler: ({ deviceId }) => deleteDevice(deviceId),
  },
};

export const handler = async (event) => {
  try {
    const route = ROUTES[event.path];
    if (!route) {
      return buildResponse({
        statusCode: 404,
        body: {
          error: "NotFound",
          message: "The requested resource was not found",
        },
      });
    }

    if (route.method !== event.httpMethod) {
      return buildResponse({
        statusCode: 405,
        body: {
          error: "MethodNotAllowed",
          message: "The request method is not supported by the target resource",
        },
      });
    }

    let body = {};
    if (event.body) {
      try {
        body =
          typeof event.body === "string" ? JSON.parse(event.body) : event.body;
      } catch {
        throwError("ValidationError", "Invalid JSON in request body");
      }
    }

    route.required?.forEach((field) => requireField(body, field));

    return buildResponse({ body: await route.handler(body) });
  } catch (error) {
    console.error(error.name, error.message);

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
