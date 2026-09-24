# Protocolo del POS Bridge (versión 1)

Solo hace falta si su kiosco no puede usar el SDK Android ni `bridge-client.js`.

## Conexión

| Transporte | Detalle |
|---|---|
| TCP | Puerto `8520` del POS. Los mensajes van uno detrás de otro. El Bridge cierra la conexión a los 120 s sin tráfico. |
| WebSocket | Puerto `8521`. Cada mensaje va en un frame binario. |
| Bluetooth | RFCOMM con el UUID `6f0b3c7e-2a4d-4e3b-9a61-5b8a3c1d9e42`, o el SPP estándar `00001101-0000-1000-8000-00805f9b34fb`. |

## Formato de cada mensaje

```
[ 4 bytes: N, entero sin signo, big-endian ][ 32 bytes: HMAC-SHA256 ][ N - 32 bytes: JSON en UTF-8 ]
```

- `N` = 32 + largo del JSON. Mínimo 34, máximo 262.144 (256 KB).
- El HMAC se calcula sobre los bytes exactos del JSON que se envían.
- Todo mensaje es un objeto JSON con el tipo en el campo `t`.

## Claves y saludo

```
clave  = PBKDF2-HMAC-SHA1(pin, "sbp1-pin|" + ID_KIOSCO_EN_MAYÚSCULAS, 100000 iteraciones, 32 bytes)
```

El código de emparejamiento `K01-4827-1936` se lee como ID `K01` y PIN `48271936`.

1. El kiosco envía `HELLO`, firmado con `clave`:
   ```json
   {"t":"HELLO","v":1,"kiosk_id":"K01","nonce":"<16 bytes aleatorios en hex>","sdk":"mi-kiosco-1.0"}
   ```
2. El Bridge responde `HELLO_OK`, firmado con `clave`. Verifique la firma y que `echo` sea su nonce:
   ```json
   {"t":"HELLO_OK","v":1,"nonce":"<hex>","echo":"<nonce del kiosco>","caps":{"protocol":1,"bridge_id":"…","model":"…","simulator":false}}
   ```
3. Ambos calculan la clave de sesión:
   ```
   sesion = HMAC-SHA256(clave, "sbp1-session|" + nonce_kiosco + "|" + nonce_bridge)
   ```
4. Desde aquí, todo mensaje va firmado con `sesion` y lleva `"seq"`: 1, 2, 3… en cada dirección. Rechace un mensaje con firma inválida o con `seq` que no sea mayor que el anterior.

Si el saludo falla, el Bridge envía `{"t":"ERROR","code":"…","message":"…"}` firmado con una clave de 32 bytes en cero y cierra. Códigos: `BRIDGE_AUTH` (código incorrecto), `BRIDGE_KIOSCO_DESCONOCIDO`, `BRIDGE_KIOSCO_DESHABILITADO`, `BRIDGE_KIOSCO_BLOQUEADO` (5 intentos fallidos, esperar 5 minutos), `BRIDGE_VERSION`.

### Valores de prueba

```
ID K01, PIN 12345678
clave        = d356bcfa27042e5e210fe265ee79cce31dc48edd0294b615d21b0fac0c5de133
nonce_kiosco = 00112233445566778899aabbccddeeff
nonce_bridge = ffeeddccbbaa99887766554433221100
sesion       = 4c87bef5fb8944be13e53fd9f328154560a55cbdc9a351e7db0e1d67eb8a0c2a

HELLO = {"t":"HELLO","v":1,"kiosk_id":"K01","nonce":"00112233445566778899aabbccddeeff","sdk":"0.1.0"}
N     = 0x0000007d (125)
HMAC  = 43501746720b4adb8b421e598c65c17f78d057bce1b09871578d1afe106286c1
```

## Operaciones

```json
{"t":"REQUEST","request_id":"b05ce87b-5315-4f6f-8b6b-28cab72ae6cc","op":"COMPRA","app_id":"PGSP2M0005",
 "params":{"cedula":"V12345678","monto_centimos":1050,"cuenta":"1"},"seq":1}
```

| Campo | Regla |
|---|---|
| `request_id` | 8 a 64 caracteres: letras, dígitos, `-` o `_`. Uno nuevo por cobro. |
| `op` | `COMPRA`, `ANULACION`, `ANULACION_POR_AUTORIZACION`, `CIERRE`, `ULTIMA_TRANSACCION`, `TEST_COMUNICACION`, `CONF_SIM`, `CONF_WIFI`, `BORRAR_LOTE`, `BORRAR_REVERSO` |
| `app_id` | El registrado para el kiosco. Hasta 64 caracteres. |
| `params.monto_centimos` | Solo `COMPRA`. Entero mayor que cero (`1050` = Bs. 10,50). |
| `params.cedula` | Solo `COMPRA`, opcional. Letra V, E, J, P o G opcional y de 4 a 10 dígitos. |
| `params.cuenta` | Solo `COMPRA`, opcional. `"0"` Principal, `"1"` Ahorro, `"2"` Corriente. |
| `params.codigo_autorizacion` | Obligatorio en `ANULACION_POR_AUTORIZACION`. |

Respuestas del Bridge, en este orden:

| Mensaje | Campos | Significado |
|---|---|---|
| `ACK` | `request_id` | Recibida, se va a ejecutar. |
| `STATUS` | `request_id`, `status`, `detail` | Avance: `EN_APLICATIVO`, `EN_CURSO`, `CIERRE_AUTOMATICO`, `CONCILIANDO`. |
| `RESULT` | `request_id`, `result` | Respuesta final (formato abajo). |
| `BUSY` | `request_id`, `active_request_id` | El POS atiende otra operación. No se ejecutó. |
| `ERROR` | `request_id`, `code`, `message` | Rechazada sin ejecutar. |

Espere el `ACK` hasta 10 s y el `RESULT` hasta 240 s (el cliente está frente al POS).

### Respuesta (`result`)

```json
{
  "op": "COMPRA", "op_code": "200",
  "code": "00", "message": "APROBADA", "approved": true,
  "requires_signature": false, "requires_closure": false,
  "source": "APLICATIVO",
  "data": { "codigo_autorizacion": "213382", "reference": "000414", "amount": "10,50", "…": "…" },
  "recovered": false
}
```

- `approved` es `true` solo si `code` es `00`.
- `data` trae la respuesta del Aplicativo para el voucher.
- Si la compra devolvió 425, el Bridge hizo el cierre y lo incluye en `auto_closure`.
- Con `code` = `BRIDGE_INDETERMINADO`, `last_transaction` trae la respuesta de la operación 140 para comparar.

## Si se cae la conexión

- Reconecte y reenvíe el **mismo** `REQUEST` con el mismo `request_id`. El Bridge nunca ejecuta dos veces un `request_id`: si ya terminó devuelve el resultado guardado (`recovered: true`); si sigue en curso, envía el `RESULT` cuando termine.
- Para consultar sin ejecutar nada: `{"t":"QUERY","request_id":"…"}` → `{"t":"QUERY_RESULT","request_id":"…","state":"…","result":{…}}`. Estados: `NOT_FOUND`, `IN_PROGRESS`, `DONE`, `ORPHAN`.

## Mantener la conexión

Envíe `{"t":"PING"}` cada 30 s; el Bridge responde `{"t":"PONG"}`.

## Errores de `ERROR` y de `result.code`

| Código | Qué pasó |
|---|---|
| `BRIDGE_PARAMETROS_INVALIDOS` | Formato inválido de `request_id`, cédula o monto. |
| `BRIDGE_APP_ID_NO_PERMITIDO` | El `app_id` no es el registrado para el kiosco. |
| `BRIDGE_NO_LISTO` | El Bridge no está abierto en el POS. |
| `BRIDGE_REQUEST_ID_EN_USO` | Ese `request_id` ya se usó para otra operación. |
| `BRIDGE_MENSAJE_INVALIDO` | Mensaje mal formado. |
| `BRIDGE_CANCELADO` | El cliente canceló en el POS. |
| `BRIDGE_TIMEOUT` | El Aplicativo no respondió a tiempo. |
| `BRIDGE_APLICATIVO_NO_INSTALADO` | Falta el Aplicativo Financiero en el POS. |
| `BRIDGE_INDETERMINADO` | El POS se reinició a mitad de la operación. |
