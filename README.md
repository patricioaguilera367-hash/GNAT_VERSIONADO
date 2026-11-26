# GNAT — historial de versiones

Iteraciones de la extensión de navegador "Centrality Local" (Planificador PT DMS),
publicadas como un commit por versión. Cada tag `vX.Y.Z` marca un snapshot completo
de la extensión tal como se construyó en ese paso.

Este repositorio es un **archivo histórico**, no la rama de desarrollo. La carpeta
`extension/` siempre contiene el estado de la versión del último commit de snapshot,
que es `v13.0.6` y sirve como build cargable.

Los archivos se guardan byte a byte como se construyeron: `.gitattributes` desactiva
la normalización de finales de línea, así que un `git checkout` de cualquier tag
reproduce el build original sin alteraciones.

## Cómo saber qué se resolvió en cada paso

```bash
git log --oneline                    # la secuencia completa de versiones
git diff v11.2 v11.4                 # qué cambió entre dos versiones cualesquiera
git diff v10.8 v11.0 --stat          # cuánto cambió, sin el detalle
git show v10.7                       # el snapshot exacto de una versión
git checkout v10.7 -- extension      # recuperar esa versión en el árbol de trabajo
```

## Cómo cargar la extensión

1. Descargar o clonar este repositorio.
2. Abrir `chrome://extensions` en el navegador.
3. Activar **Modo de desarrollador**.
4. **Cargar descomprimida** y elegir la carpeta `extension/`.

Para cargar una versión anterior, primero hay que materializarla:

```bash
git checkout v10.7 -- extension
```

## Índice de versiones

| Tag | Fecha | Manifest | Archivos | Nota |
| --- | --- | --- | --- | --- |
| `v1.5` | 2026-11-18 08:49 | 1.5 | 8 |  |
| `v1.6` | 2026-11-18 10:12 | 1.6 | 8 |  |
| `v1.7` | 2026-11-18 12:01 | 1.7 | 8 |  |
| `v1.7.1` | 2026-11-18 12:13 | 1.7.1 | 6 |  |
| `v1.8.0` | 2026-11-18 12:19 | 1.8.0 | 6 |  |
| `v1.8.1` | 2026-11-18 12:28 | 1.8.1 | 6 |  |
| `v1.9.0` | 2026-11-18 12:32 | 1.9.0 | 6 |  |
| `v1.9.1` | 2026-11-18 12:37 | 1.9.1 | 6 |  |
| `v1.9.2` | 2026-11-18 12:41 | 1.9.2 | 6 |  |
| `v1.9.3` | 2026-11-18 12:52 | 1.9.3 | 6 |  |
| `v1.10.0` | 2026-11-18 13:15 | 1.10.0 | 6 |  |
| `v1.10.1` | 2026-11-18 13:48 | 1.10.1 | 6 |  |
| `v1.11.0` | 2026-11-18 14:16 | 1.11.0 | 6 |  |
| `v1.11.1` | 2026-11-18 14:19 | 1.11.1 | 6 |  |
| `v1.12.0` | 2026-11-18 14:32 | 1.12.0 | 6 |  |
| `v10.1` | 2026-11-18 17:29 | 10.2.0 | 3 | el directorio dice 10.1 pero el manifest declara 10.2.0; el tag sigue al directorio; el tag dice 10.1 y el manifest declara 10.2.0 |
| `v10.3` | 2026-11-19 12:46 | 10.3.0 | 3 | el tag dice 10.3 y el manifest declara 10.3.0 |
| `v10.4` | 2026-11-19 14:05 | 10.3.0 | 3 | el directorio dice 10.4 pero el manifest declara 10.3.0; el tag sigue al directorio; el tag dice 10.4 y el manifest declara 10.3.0 |
| `v10.5` | 2026-11-19 14:27 | 10.5.0 | 3 | el tag dice 10.5 y el manifest declara 10.5.0 |
| `v10.6` | 2026-11-19 14:49 | 10.6.0 | 3 | el tag dice 10.6 y el manifest declara 10.6.0 |
| `v10.7` | 2026-11-19 17:14 | 10.7.0 | 3 | el tag dice 10.7 y el manifest declara 10.7.0 |
| `v10.8` | 2026-11-19 17:57 | 10.8.0 | 3 | el tag dice 10.8 y el manifest declara 10.8.0 |
| `v11.0` | 2026-11-20 13:29 | 11.0.0 | 3 | el tag dice 11.0 y el manifest declara 11.0.0 |
| `v11.1` | 2026-11-20 13:53 | 11.1.0 | 3 | el tag dice 11.1 y el manifest declara 11.1.0 |
| `v11.2` | 2026-11-20 13:59 | 11.2.0 | 3 | el tag dice 11.2 y el manifest declara 11.2.0 |
| `v11.4` | 2026-11-20 14:15 | 11.4.0 | 3 | el tag dice 11.4 y el manifest declara 11.4.0 |
| `v11.4.1` | 2026-11-20 14:20 | 11.4.1 | 3 |  |
| `v11.5` | 2026-11-20 14:39 | 11.5.0 | 3 | el tag dice 11.5 y el manifest declara 11.5.0 |
| `v12.0` | 2026-11-23 09:46 | 12.0.0 | 3 | el tag dice 12.0 y el manifest declara 12.0.0 |
| `v13.0` | 2026-11-23 10:45 | 13.0.0 | 6 | el tag dice 13.0 y el manifest declara 13.0.0 |
| `v13.0.1` | 2026-11-23 10:50 | 13.0.1 | 6 |  |
| `v13.0.3` | 2026-11-23 11:00 | 13.0.3 | 6 |  |
| `v13.0.4` | 2026-11-23 11:14 | 13.0.4 | 6 |  |
| `v13.0.5` | 2026-11-23 11:59 | 13.0.5 | 6 |  |
| `v13.0.6` | 2026-11-23 16:26 | 13.0.6 | 6 |  |
| `v13.0.7` | 2026-11-24 14:28 | 13.0.7 | 6 |  |
| `v13.0.8` | 2026-11-24 14:28 | 13.0.8 | 6 |  |
| `v13.0.9` | 2026-11-24 14:28 | 13.0.9 | 6 |  |
| `v13.1.0` | 2026-11-24 14:38 | 13.1.0 | 6 |  |
| `v13.1.1` | 2026-11-24 14:38 | 13.1.1 | 6 |  |
| `v13.1.2` | 2026-11-24 14:48 | 13.1.2 | 6 |  |
| `v13.1.3` | 2026-11-24 14:58 | 13.1.3 | 6 |  |
| `v13.1.4` | 2026-11-24 15:24 | 13.1.4 | 6 |  |
| `v13.1.5` | 2026-11-24 16:36 | 13.1.5 | 6 |  |
| `v13.1.6` | 2026-11-24 16:59 | 13.1.6 | 6 |  |
| `v13.1.7` | 2026-11-24 18:07 | 13.1.7 | 6 |  |
| `v13.1.8` | 2026-11-25 08:59 | 13.1.8 | 6 |  |
| `v13.1.9` | 2026-11-25 09:03 | 13.1.9 | 6 |  |
| `v13.2.0` | 2026-11-25 09:15 | 13.2.0 | 6 |  |
| `v13.2.1` | 2026-11-25 09:43 | 13.2.1 | 6 |  |
| `v13.2.2` | 2026-11-26 08:40 | 13.2.2 | 6 |  |
| `v13.2.3` | 2026-11-26 09:52 | 13.2.3 | 6 |  |

## Anomalías del historial original

Documentadas acá porque el repositorio de builds no las explica por sí solo:

- **`v10.4` no aporta cambios.** El contenido es byte a byte idéntico al de la versión anterior, incluido el `manifest.json`. Se conserva como paso propio —con commit vacío y tag— porque el build existió, pero no hay nada que diffear contra el paso previo.
- **`v10.1` declara manifest `10.2.0`.** El nombre de la carpeta y la versión declarada no coinciden: la numeración de la serie 10 arranca desplazada. El tag sigue el nombre de carpeta que se usó al construir.
- **`v10.4` declara manifest `10.3.0`, igual que `v10.3`.** No es solo el número: los tres archivos publicados son idénticos. Se sospecha un rebuild sin cambios reales.
- **Huecos en la secuencia:** no existe `10.2` como build propio, no existe `11.3` y no existe `13.0.2`. Se publica lo que existe; no se completa lo que falta.
- **`1.9.3` → `1.10.0`** es el único salto de numeración no consecutivo de la serie 1.x: no hubo `1.9.4`–`1.9.9`.
- **`v11.4.1`, `v11.5` y `v12.0`** llevan un cuarto componente en el campo `name` del manifest que no aparece en `version`.

## Qué no se publicó, y por qué

- **`pt-263781.json`** (presente en 14 de los 35 builds): contiene topología real de la subestación PT-263781 —circuito, bloques, roles y coordenadas—. Este repositorio es público, así que el archivo queda fuera de todos los snapshots.
- **Los `.zip` originales** (13 archivos): se verificó entrada por entrada que cada uno duplica exactamente el contenido de su carpeta hermana, sin archivos únicos. Los snapshots de git los reemplazan sin pérdida de información.

## Nota sobre `BUILD.txt`

Los builds de la serie `1.x` incluyen un `BUILD.txt` generado por el script de build.
Se conserva tal cual porque es parte del snapshot; por eso menciona la ruta local de la
máquina donde se generó.
