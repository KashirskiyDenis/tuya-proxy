# Tuya Cloud Proxy

Serverless-функция (Yandex Cloud Functions, Node.js, ES-модули), которая проксирует запросы к [Tuya Cloud API](https://developer.tuya.com/en/docs/iot/new-singnature?id=Kbw0q34cs2e5g) (дата-центр EU, `https://openapi.tuyaeu.com`). Функция сама подписывает запросы по схеме Tuya (HMAC-SHA256), получает и кэширует токен доступа и справочник категорий устройств.

## Возможности

- Список устройств пользователя с названиями категорий.
- Чтение свойств устройства (shadow properties).
- Отправка команд устройству (`/commands`).
- Запись свойств устройства (`/shadow/properties/issue`).
- Автоматическое получение и обновление токена.
- Двухуровневый кэш токена и категорий: память инстанса, затем Object Storage.

## Как это работает

```
Клиент → API Gateway (авторизатор) → Функция → Tuya Cloud
                                         ↕
                                  Yandex Object Storage
                                  (кэш токена и категорий)
```

### Подпись запросов

Для каждого запроса строится подпись по схеме Tuya:

```
stringToSign = METHOD \n SHA256(body) \n signatureHeaders \n url
sign         = HMAC-SHA256(ACCESS_ID + accessToken + t + stringToSign, ACCESS_SECRET).toUpperCase()
```

Тело запроса сериализуется один раз, и одна и та же строка идёт и в подпись, и в `fetch`. Для запроса токена `accessToken` пустой.

### Кэширование

| Данные | Память | Object Storage | Источник |
|---|---|---|---|
| Токен доступа | да | `cache-token.json` | `/v1.0/token?grant_type=1` |
| Категории устройств | да | `cache-categories.json` | `/v1.0/iot-03/device-categories` |

Токен обновляется, если до его истечения осталось меньше `TOKEN_REFRESH_BUFFER_MS` (60 секунд). Категории загружаются лениво, только в `/device-list`. Если хранилище недоступно, ошибка пишется в лог, а данные запрашиваются у Tuya.

## Конфигурация

Переменные окружения функции:

| Переменная | Описание |
|---|---|
| `TUYA_ACCESS_ID` | Access ID проекта в Tuya IoT Platform |
| `TUYA_ACCESS_SECRET` | Access Secret проекта |
| `TUYA_UID` | UID пользователя, чьи устройства запрашиваются |
| `TUYA_BUCKET_NAME` | Имя бакета Yandex Object Storage для кэша |

Константы в коде:

| Константа | Значение | Описание |
|---|---|---|
| `BASE_URL` | `https://openapi.tuyaeu.com` | Endpoint Tuya (EU). Для другого региона замените на соответствующий |
| `ABORT_TIMEOUT_MS` | `10000` | Таймаут запроса к Tuya |
| `TOKEN_REFRESH_BUFFER_MS` | `60000` | За сколько до истечения обновлять токен |

Клиент S3 настроен на Yandex Object Storage (`https://storage.yandexcloud.net`, регион `ru-central1`). Учётные данные доступа к хранилищу функция получает из своего окружения (например, через привязанный сервисный аккаунт), у аккаунта должны быть права на чтение и запись в бакет.

## API

Все роуты определяются по `event.path`. Тело запроса передаётся в JSON. Аутентификация выполняется авторизатором на API Gateway, сама функция клиентов не проверяет.

### `/device-list`

Возвращает список устройств пользователя `TUYA_UID`. К каждому устройству добавляется поле `category_title` (название категории).

Тело запроса не требуется.

### `/device-properties`

Возвращает свойства устройства, которые оно передало в облако.

```json
{ "deviceId": "bf1234567890abcdef" }
```

Ответ: содержимое поля `properties` из ответа Tuya.

### `/set-status`

Отправляет команду устройству (`POST /v1.0/devices/{id}/commands`).

```json
{ "deviceId": "bf1234567890abcdef", "code": "switch_1", "value": true }
```

Ответ: поле `result` из ответа Tuya.

### `/set-property`

Записывает свойство устройства (`POST /v2.0/cloud/thing/{id}/shadow/properties/issue`).

```json
{ "deviceId": "bf1234567890abcdef", "code": "switch_led", "value": true }
```

Ответ: поле `result` из ответа Tuya.

> Формат тела для этого эндпоинта стоит сверить с документацией Tuya на вашем устройстве: для некоторых версий API поле `properties` ожидается строкой с JSON.

## Ошибки

Ответ об ошибке имеет вид:

```json
{ "error": "TuyaError", "message": "1010" }
```

| Код | `error` | Причина |
|---|---|---|
| 400 | `ValidationError` | Некорректный JSON в теле запроса |
| 404 | `Not Found` | Неизвестный путь |
| 502 | `TuyaError` | Tuya вернула `success: false`, в `message` код ошибки |
| 502 | `FetchError` | Сеть, таймаут, не-2xx ответ или не-JSON от Tuya |
| 500 | `InternalError` | Любая другая ошибка функции |

Ошибки логируются через `console.error`.

## Развёртывание

1. Установите зависимость:

   ```bash
   npm install @aws-sdk/client-s3
   ```

2. В `package.json` включите ES-модули:

   ```json
   { "type": "module" }
   ```

3. Создайте бакет в Object Storage и сервисный аккаунт с правами на чтение и запись в него.
4. Создайте функцию в Yandex Cloud Functions (рантайм Node.js), задайте переменные окружения и привяжите сервисный аккаунт.
5. Точка входа: `index.handler` (имя файла и экспорт `handler`).
6. Подключите функцию к API Gateway и настройте авторизатор на нужных роутах.

## Структура кода

| Часть | Назначение |
|---|---|
| `generateSignature`, `sha256`, `hmacSha256` | Подпись запросов к Tuya |
| `tuyaRequest` | Единая точка вызова Tuya: токен, подпись, таймаут, разбор ответа и ошибок |
| `readFromStorage`, `writeToStorage` | Работа с кэшем в Object Storage |
| `ensureToken`, `ensureCategories` | Получение токена и категорий через кэш |
| `getDeviceList`, `getDeviceProperties`, `setDeviceStatus`, `setDeviceProperty` | Методы Tuya API |
| `buildResponse` | Формирование HTTP-ответа |
| `handler` | Точка входа: разбор тела, маршрутизация, обработка ошибок |

## Известные ограничения

- Входные данные (`deviceId`, `code`, `value`) не валидируются, предполагается, что клиент доверенный.
- Один токен на все инстансы функции: при параллельном холодном старте несколько инстансов могут одновременно запросить новый токен.
- Если Tuya отзовёт токен раньше срока, запросы будут падать до его истечения по расчёту функции. Автоматического сброса кэша и повтора нет.
- Переменные окружения при старте не проверяются.
