# Instrucciones para agentes

Leé primero `README.md`: describe la arquitectura, los comandos y el contrato de versiones. Este
archivo sólo agrega lo que un agente necesita y no conviene repetir en dos lugares.

## Reglas

- **La fuente es `src/`.** `build-versions/` es salida generada: nunca se edita a mano.
- **Una versión construida no se reescribe.** El defecto se corrige en `src/` y se publica una
  versión nueva.
- **Datos de producción jamás al repositorio.** El repositorio es público. `tools/data-guard.mjs`
  los detecta por nombre, extensión y contenido; corre antes de publicar.
- **Un chequeo se escribe contra la versión anterior.** Si el chequeo no falla en el build previo,
  no prueba nada. Nada se declara verde sin haberlo visto rojo.
- **La documentación se verifica contra el código**, no se copia de una sesión anterior. Una
  versión escrita a mano en un README es una contradicción esperando a ocurrir: derivarla o
  quitarla.
- **Una regla vive en un solo lugar.** Si aparece en dos, una de las dos es una copia que va a
  quedar vieja; la otra la referencia.

## Antes de afirmar que algo está terminado

1. Corré el chequeo que cubre el cambio y mostrá su salida.
2. Corré el mismo chequeo contra el build anterior y confirmá que falla.
3. Revisá que la documentación afectada siga diciendo la verdad.
4. Nombrá lo que quedó sin verificar, en vez de omitirlo.
