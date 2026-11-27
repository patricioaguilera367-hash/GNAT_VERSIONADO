# Arnés de verificación

Carga la extensión en un navegador real y devuelve un JSON con lo que pasó, en vez de
pedirle a una persona que describa lo que vio. Sin dependencias: usa Node y el CDP del
navegador que ya tenés instalado.

## Por qué existe

El patrón que este arnés reemplaza es este:

> el agente formula una hipótesis, escribe un diagnóstico, **te pide que ejecutes y le
> cuentes**, y con ese dato formula otra hipótesis.

Así no hay convergencia: cada vuelta agrega información sin descartar ninguna, y el
humano termina siendo el sensor. Un experimento que puede decir **NO** cierra el bucle;
un diagnóstico no.

## Requisitos

- Node 24 o superior (usa `WebSocket` global).
- Brave, Edge o Chrome instalado. Se detecta solo; `browserPath` lo fuerza.

## Flujo

```bash
# 1. El arnés se prueba a sí mismo. No toca tu sitio ni necesita sesión.
node tools/harness/harness.mjs --selftest

# 2. Copiá la plantilla y completá los valores del sitio.
cp tools/harness/config.example.json tools/harness/config.json

# 3. Iniciá sesión UNA vez. Queda guardada en el perfil persistente.
node tools/harness/harness.mjs --login

# 4. ¿Sigue viva la sesión?
node tools/harness/harness.mjs --check-auth

# 5. Corré un escenario.
node tools/harness/harness.mjs --run /ruta/al/escenario.json
```

La carpeta del perfil y los artefactos viven en `%LOCALAPPDATA%\gnat-harness\`, nunca
dentro del repositorio: el perfil contiene cookies de sesión activas.

## `config.json`

| Campo | Qué es |
| --- | --- |
| `browserPath` | Ruta al ejecutable. `null` = detección automática. |
| `profileDir` | Carpeta del perfil persistente. `null` = `%LOCALAPPDATA%\gnat-harness\profile`. |
| `extensionDir` | Carpeta del build a cargar, por ejemplo `build-versions/centrality_v13.0.6`. |
| `startUrl` | URL que hay que abrir para llegar al mapa. |
| `headless` | `true` para correr sin ventana. `--login` siempre abre con ventana. |
| `selectors.loggedIn` | Selector CSS que **sólo existe** con sesión iniciada (el contenedor del mapa). |
| `selectors.login` | Selector CSS del formulario de login. |

Con esos dos selectores el arnés distingue "no hay sesión" de "el código está roto". Esa
distinción es la que evita una tanda de diagnósticos falsos cuando lo único que pasó fue
que venció la sesión.

## Formato del escenario

```json
{
  "startUrl": "https://sitio/planificador",
  "selectors": { "loggedIn": "#mapa", "login": "form#login" },
  "steps": [
    { "waitFor": "return document.querySelector('#mapa') !== null" },
    { "eval": "return document.querySelectorAll('[data-polo]').length" },
    { "evalInServiceWorker": "return chrome.runtime.getManifest().version" }
  ]
}
```

Cada `eval` es el **cuerpo de una función async**: hay que usar `return` explícito. Un
paso que devuelve `false` o `null` se considera fallido y corta el escenario.

`startUrl` y `selectors` en el escenario son opcionales: si están, ganan sobre `config.json`
(útil para correr contra fixtures locales sin configurar nada).

## Códigos de salida

| Código | Significado | Qué hacer |
| --- | --- | --- |
| 0 | Todo pasó | — |
| 1 | Un paso falló | Hay un defecto real, o el escenario está mal escrito |
| 2 | `SESSION_EXPIRED` | Correr `--login`. **No** es un bug de la extensión |
| 3 | Falta configuración | Completar `config.json` |

Cada corrida escribe un artefacto JSON en `%LOCALAPPDATA%\gnat-harness\artifacts\`.

## Qué prueba y qué no

Prueba la **integración**: que la extensión cargue, que su service worker responda, que el
panel aparezca, que los mensajes lleguen al sitio real.

No prueba la **lógica de negocio** (parseo del preset, resolución de polos, cálculo de
zonas). Eso corresponde a un nivel sin red y sin sesión, contra fixtures locales, que es
determinista y se puede correr siempre. Mezclar los dos niveles en el mismo chequeo es lo
que hace que un test lento y frágil tape un bug de lógica.

## El arnés también se verifica

`--selftest` corre seis chequeos contra `fixtures/`: clasificación del muro de login,
clasificación de página autenticada, `await` dentro de un snippet, lectura del DOM,
propagación de excepciones y espera activa. Si esa plomería se rompe, el arnés no sirve
para juzgar nada, así que falla antes de intentarlo.
