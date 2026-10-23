# Seguridad

[English](../../SECURITY.md) · [Українська](../uk/SECURITY.md) · [Español](SECURITY.md) · [Polski](../pl/SECURITY.md) · [Čeština](../cs/SECURITY.md)

Esta es una traducción del [documento principal en inglés](../../SECURITY.md).

Actualmente BRAMA está orientada al uso local. Escucha en la interfaz loopback, guarda las credenciales de sesión en una pestaña del navegador y conserva el estado de la campaña en SQLite. La aplicación no es un servicio de cuentas por Internet. No expongas el servidor de desarrollo directamente a Internet público.

El servidor valida los comandos y filtra los datos privados para cada participante. La propiedad de las fichas de mapa, el acceso a las fichas de personaje, el acceso al diario y los destinatarios de las presentaciones son permisos distintos. La interfaz del cliente no constituye una barrera de seguridad. El HTML se sanea; los archivos importados son datos inertes, no extensiones ejecutables.

Si sospechas que hay una vulnerabilidad, usa la función de informes privados de vulnerabilidades de GitHub si está disponible en este repositorio. En caso contrario, abre una incidencia para solicitar un contacto privado sin publicar detalles de explotación ni datos privados. Incluye las versiones afectadas, una reproducción mínima con datos sintéticos, el comportamiento esperado y real, y el impacto. Nunca incluyas tokens de sesión, códigos de invitación, bases de datos en uso ni material de campañas de otra persona.

Esta versión temprana no ofrece un plazo de respuesta garantizado ni un período de soporte a largo plazo. Haz copias de seguridad de los datos locales y revisa los cambios antes de actualizar.
