# BRAMA VTT

**Una mesa virtual multilingüe de [CrioMant](https://github.com/CrioNIK).**

[English — original](../../README.md) · [Українська](../uk/README.md) · [Español](README.md) · [Polski](../pl/README.md) · [Čeština](../cs/README.md)

Estoy creando BRAMA como un espacio compartido para historias de rol: un mapa, personajes, dados, diarios y una separación clara entre lo que ve la persona que dirige la partida y cada jugador. La aplicación se ejecuta en tu ordenador y guarda el estado de la campaña en una base de datos local.

**Código disponible para uso no comercial. El uso comercial requiere mi autorización previa por escrito.** Consulta la [licencia](LICENSE.md). Esta restricción significa que el proyecto no se distribuye con una licencia de código abierto según la definición de la OSI. Las dependencias de terceros conservan sus propias licencias, recogidas en los [avisos de terceros](THIRD_PARTY_NOTICES.md).

## Funciones disponibles

- Escenas con cuadrícula, niveles, fichas, paredes, puertas, luces, medición y un modelo de visión limitado.
- Sesiones independientes para dirección y jugadores, permisos explícitos y filtrado de información privada en el servidor.
- Hojas de personaje, inventario, pruebas de característica, tiradas de salvación, habilidades, recursos, efectos y progresión configurable.
- Costes de acciones, resultados de dados y aplicación explícita de daño o curación como pasos separados.
- Una cola de combate con iniciativa, orden de empates, contadores y restauración del turno anterior.
- Diarios con texto con formato, imágenes, carpetas, permisos de documentos y páginas, notas privadas de dirección y presentaciones dirigidas.
- Exportación JSON de campañas, importación validada de documentos de intercambio y confirmaciones persistentes para los comandos compatibles.

La interfaz admite **inglés, español, ucraniano, polaco y checo**. El idioma inicial es ucraniano; el selector recuerda tu elección. Cambiar el idioma de la interfaz no traduce ni sustituye el contenido escrito por los jugadores. El inglés es el idioma original de la documentación; las otras cuatro ediciones cubren el mismo contenido.

## Ejecutar en local

Instala **Node.js 24.12 o posterior dentro de la rama 24.x** y ejecuta:

```sh
git clone https://github.com/CrioNIK/brama-vtt.git
cd brama-vtt
npm ci
npm run build
npm start
```

Abre **http://127.0.0.1:8015/**. Crea una campaña y abre su invitación en otra pestaña para entrar como jugador. La dirección concede por separado el acceso a fichas y personajes. Las credenciales de sesión permanecen en esa pestaña; conserva disponible la pestaña de dirección.

El servidor escucha únicamente en la interfaz local. Las invitaciones funcionan en este ordenador; no se incluyen alojamiento en Internet ni recuperación de cuentas. `PORT` cambia el puerto local y `VTT_DB` cambia la ruta de SQLite. La base de datos predeterminada es `server/data/vtt.sqlite`.

## Jugar y crear

Usa las herramientas del mapa para seleccionar y mover objetos, medir distancias o añadir fichas, paredes, puertas y luces. Elige una escena y un nivel antes de editar. La propiedad de una ficha determina quién puede manejarla; los permisos de la hoja determinan quién puede consultar los datos del personaje.

Crea expresamente las acciones y sus costes de recursos. Revisa el coste antes de ejecutar una acción. Una acción completada puede producir una tirada; aplicar su daño o curación es otra operación explícita. Así, mostrar un resultado de dados no cambia automáticamente los puntos de vida.

En combate, añade participantes, establece o tira iniciativa e inicia el encuentro. La cola admite participantes derrotados, empates, contadores y la reversión de la transición anterior. No impone todas las reglas ni impide mover fichas fuera de turno.

Usa los diarios para documentos y notas. Las páginas pueden heredar el acceso del documento o tener permisos propios. Una presentación dirigida envía una copia guardada de las páginas elegidas sin conceder acceso permanente al original. Los cambios posteriores no modifican esa copia. Archivar un diario revoca sus presentaciones activas; restaurarlo no vuelve a enviarlas.

Exporta la campaña periódicamente. La exportación es un documento JSON portátil; no sustituye a la base de datos ni garantiza una restauración con un solo clic. Detén el servidor antes de copiar la base y sus archivos SQLite asociados para obtener una copia local coherente. No publiques bases de campañas, exportaciones, códigos de invitación ni credenciales de sesión en un repositorio público.

## Desarrollo y verificación

```sh
npm test
npm run typecheck
npm run build
```

Para desarrollar el cliente por separado, ejecuta `npm run dev` y `npm run client` en dos terminales. Vite usa el puerto 5173 y redirige la API y WebSocket al puerto 8015.

El proyecto utiliza React, TypeScript, Vite, SQLite de Node, WebSockets, Tiptap y saneamiento HTML. `client/` contiene la interfaz; `server/`, los comandos autoritativos y el almacenamiento; `shared/`, los contratos y reglas auxiliares; y `tests/`, las pruebas de regresión y sus datos autocontenidos. Las traducciones usan claves en inglés y parámetros con nombre; los textos de los jugadores no son claves de traducción.

Los cambios deben preservar la validación de comandos, los permisos, las escrituras atómicas y los reintentos. Perder una confirmación no demuestra que el comando haya fallado. Usa la recuperación del resultado en la interfaz en vez de emitir otra operación mientras se desconoce el resultado anterior. Consulta [Contribuir](CONTRIBUTING.md) y [Seguridad](SECURITY.md).

## Límites actuales

BRAMA es una aplicación funcional en una etapa temprana. No implementa un reglamento completo, scripts sin restricciones, fusión colaborativa de texto, importación y exportación completa de diarios externos, marcadores de mapa, páginas de audio/vídeo/PDF ni alojamiento público. Las reglas importadas no compatibles se notifican o rechazan; no se ejecutan silenciosamente. La visión y la edición móvil tienen límites explícitos. Las pruebas correctas demuestran los contratos probados, no compatibilidad universal ni todos los escenarios posibles.

## Autor y permisos

Creado y mantenido por **CrioMant / [CrioNIK](https://github.com/CrioNIK)**. Solicita permiso comercial mediante el formulario **Commercial permission** del repositorio. Indica el uso previsto, el modelo de distribución y la organización. Abrir una solicitud no concede permiso: espera un acuerdo explícito por escrito.

Copyright © 2026 CrioMant. El código y los recursos originales de BRAMA se rigen por la [licencia](LICENSE.md). Los avisos y licencias de dependencias siguen aplicándose a sus respectivos componentes.
