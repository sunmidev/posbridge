# POS Bridge · SUNMI Venezuela

Cobre desde su kiosco a través de un POS SUNMI, por WiFi o Bluetooth.

El POS Bridge es una app que corre en el POS. Su kiosco le pide un cobro, el Bridge abre el Aplicativo Financiero, el cliente pasa la tarjeta y su kiosco recibe la respuesta.

Documentación completa: pestaña **POS Bridge** en la documentación del Aplicativo Financiero.

## Contenido

| Archivo | Qué es |
|---|---|
| `apk/pos-bridge-0.1.0.apk` | App del Bridge para instalar en el POS |
| `sdk/posbridge-core-0.1.0.jar` | SDK Android: cliente del protocolo |
| `sdk/posbridge-sdk-0.1.0.aar` | SDK Android: conexión por WiFi y Bluetooth |
| `kiosco-web/kiosco.html` | Kiosco web de prueba en un solo archivo |
| `kiosco-web/bridge-client.js` | Cliente JavaScript para integrar desde una página web |
| `PROTOCOLO.md` | Especificación del protocolo, para kioscos que no son Android ni web |

## Antes de empezar

- Su `app_id`, asignado por Sunmi Corporation C.A.
- Un POS SUNMI (Android 7.1 o superior) con el Aplicativo Financiero instalado.
- Kiosco y POS en la misma red WiFi, o emparejados por Bluetooth.

## 1. Instalar el Bridge en el POS

```bash
adb install apk/pos-bridge-0.1.0.apk
```

1. Abra el Bridge. Debe quedar en la pantalla "Listo para cobrar": si está cerrado, las operaciones se rechazan.
2. Entre al menú con 5 toques en la esquina superior derecha y defina el PIN de administrador (Ajustes → Modo quiosco).

## 2. Emparejar el kiosco

1. En el menú del Bridge: **Kioscos → Emparejar kiosco**.
2. Escriba un ID para el kiosco (por ejemplo `K01`) y su `app_id`.
3. Anote el **código de emparejamiento** (por ejemplo `K01-4827-1936`) y la **IP del POS**.

El kiosco solo puede cobrar con el `app_id` que se registró al emparejarlo.

## 3. Probar con el kiosco web

1. Abra `kiosco-web/kiosco.html` en Chrome o Edge.
2. Escriba el código de emparejamiento, su `app_id` y la IP del POS (puerto `8521`).
3. Toque **Conectar**. Si el navegador pregunta si puede conectarse a dispositivos de su red local, toque **Permitir**.
4. Haga un **Test comunicación (420)** y luego una compra.

Para probar sin tarjeta, active en el Bridge: Ajustes → Simulador del Aplicativo.

| Monto de compra | Resultado |
|---|---|
| 4,44 | Error 425 y cierre automático |
| 2,22 | Pide firma |
| 1,78 | Rechazada (91) |
| 3,33 | Cancelada por el cliente |
| Cualquier otro | Aprobada |

## 4. Integrar una app Android

Copie los dos archivos de `sdk/` a la carpeta `app/libs/` de su proyecto:

```kotlin
// app/build.gradle.kts
dependencies {
    implementation(files("libs/posbridge-core-0.1.0.jar", "libs/posbridge-sdk-0.1.0.aar"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
    implementation("androidx.core:core-ktx:1.16.0")
}
```

Requiere minSdk 25 y Java 17. Los permisos de red y Bluetooth los agrega el SDK; para Bluetooth en Android 12 o superior, pida `BLUETOOTH_CONNECT` al usuario.

```kotlin
import com.sunmivzla.posbridge.sdk.PosBridge
import com.sunmivzla.posbridge.core.client.BridgeClient
import com.sunmivzla.posbridge.core.client.TxOutcome

// Crear el cliente una sola vez, fuera del hilo principal
val client = withContext(Dispatchers.Default) {
    PosBridge.create(
        context = applicationContext,
        pairingCode = "K01-4827-1936",
        appId = "PGSP2M0005",
        transport = PosBridge.Transport.WifiFixed("192.168.1.50", 8520),   // o Bluetooth("MAC del POS")
    )
}

val requestId = BridgeClient.newRequestId()
guardarPendiente(requestId)                    // antes de cobrar

when (val r = client.compra(cedula = "V12345678", montoCentimos = 1050, requestId = requestId)) {
    is TxOutcome.Completed -> {
        borrarPendiente(requestId)
        if (r.result.approved) imprimirVoucher(r.result.data) else mostrar(r.result.message)
    }
    is TxOutcome.Busy -> { borrarPendiente(requestId); mostrar("El POS está ocupado") }
    is TxOutcome.Rejected -> { borrarPendiente(requestId); mostrar(r.message) }
    is TxOutcome.Indeterminate -> verificar(requestId)   // no cobrar de nuevo
}
```

Operaciones: `compra`, `anulacion`, `anulacionPorAutorizacion`, `cierre`, `ultimaTransaccion`, `testComunicacion`, `confSim`, `confWifi`, `borrarLote`, `borrarReverso`. Al salir de la app, llame a `client.close()`.

## 5. Integrar desde una página web

```html
<script type="module">
import { BridgeClient, resolvePairingCode, webSocketConnector, newRequestId } from './bridge-client.js';

const pc = await resolvePairingCode('K01-4827-1936');
const client = new BridgeClient({
  connector: webSocketConnector('ws://192.168.1.50:8521'),   // IP del POS
  kioskId: pc.kioskId,
  pairingKey: pc.key,
  appId: 'PGSP2M0005',
});

const out = await client.compra({ cedula: 'V12345678', montoCentimos: 1050, requestId: newRequestId() });
if (out.kind === 'completed' && out.result.approved) imprimirVoucher(out.result.data);
</script>
```

- El monto va en céntimos: `1050` son Bs. 10,50.
- Use la IP del POS, no un nombre.
- Operaciones: `compra`, `anulacion`, `anulacionPorAutorizacion`, `cierre`, `ultimaTransaccion`, `testComunicacion`, `confSim`, `confWifi`, `borrarLote`, `borrarReverso`.

## Evitar doble cobro

Guarde el `requestId` **antes** de cobrar. Si la conexión se cae, el cliente reconecta y recupera la respuesta; el POS nunca cobra dos veces el mismo `requestId`.

Si recibe `Indeterminate`, o la app se cerró a mitad de un cobro, consulte antes de cobrar otra vez:

| `consultar(requestId).state` | Qué hacer |
|---|---|
| `DONE` | Ya terminó: use `result`. |
| `NOT_FOUND` | Nunca llegó al POS: puede cobrar con un `requestId` nuevo. |
| `IN_PROGRESS` | Sigue en curso: espere y consulte de nuevo. |
| `ORPHAN` | El POS se reinició a mitad. Reenvíe la misma operación con el **mismo** `requestId`: el Bridge responde `BRIDGE_INDETERMINADO` con `last_transaction` para comparar. |

## Soporte

Sunmi Corporation C.A.
