# Contribuir a BRAMA VTT

[English](../../CONTRIBUTING.md) · [Українська](../uk/CONTRIBUTING.md) · [Español](CONTRIBUTING.md) · [Polski](../pl/CONTRIBUTING.md) · [Čeština](../cs/CONTRIBUTING.md)

Esta es una traducción del [documento principal en inglés](../../CONTRIBUTING.md).

Agradezco los informes de errores, las mejoras de accesibilidad, las traducciones y los cambios de alcance concreto. Para un cambio importante, abre una incidencia que describa el problema y el comportamiento previsto antes de implementarlo.

1. Lee [LICENSE.md](LICENSE.md) y la [licencia original en inglés](../../LICENSE.md). Envía solo material que tengas derecho a aportar. Las contribuciones usan la licencia del proyecto; enviarlas no transfiere los derechos de autor ni concede una excepción comercial automática.
2. Usa Node.js 24.12 o posterior dentro de la rama 24.x y ejecuta `npm ci`.
3. Mantén explícitos los contratos de datos, las comprobaciones de permisos y el comportamiento de los comandos. No traduzcas el contenido guardado de los usuarios ni cambies las claves técnicas del protocolo por palabras localizadas.
4. Añade o actualiza las claves de mensajes en inglés y los valores en los cinco idiomas. Conserva los marcadores de posición con nombre. Documenta el comportamiento en la documentación original en inglés y actualiza sus ediciones en ucraniano, español, polaco y checo.
5. Ejecuta `npm test`, `npm run typecheck` y `npm run build`. Comprueba las interfaces afectadas con anchos de escritorio y reducidos, incluida la interacción mediante teclado y los errores.
6. En la pull request, describe el problema, el comportamiento resultante, la verificación y las limitaciones restantes. No incluyas credenciales, datos personales de campañas, bases de datos, contenido comercial copiado ni carpetas de dependencias generadas.

Reviso las contribuciones bajo el nombre **CrioMant / CrioNIK**. La inclusión en el proyecto es una decisión de revisión técnica y no concede permiso comercial.
