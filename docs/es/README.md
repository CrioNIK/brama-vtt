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

Las propiedades de la pared ofrecen los modos **Ninguna**, **Normal** y **Limitado** por separado para visión, luz y sonido. El movimiento sigue siendo una casilla. Ninguna no bloquea; Normal bloquea en el primer cruce; Limitado permite un cruce distinto y bloquea en el segundo a lo largo de la misma línea. Los segmentos coincidentes o que se unen en el mismo extremo cuentan como un solo cruce: esta es la regla definida por BRAMA. Las puertas abiertas no bloquean. Las restricciones de sonido se guardan y se admiten en las consultas geométricas; la reproducción de audio espacial no está disponible.

**Lado de bloqueo** ofrece **Ambos lados**, **Bloquear desde la izquierda** y **Bloquear desde la derecha**. La izquierda y la derecha se definen siguiendo la flecha ordenada del extremo A al extremo B, no por los lados de la pantalla. La vista previa en directo marca A y B y resalta el lado de origen configurado; la pared direccional seleccionada muestra la misma orientación en el mapa. La dirección filtra las restricciones activadas de visión, luz, sonido y movimiento según el lado de origen antes de comprobar colisiones o contar cruces limitados. Invertir solo A y B invierte el lado físico de bloqueo; invertir los extremos e intercambiar izquierda/derecha lo conserva. Las puertas abiertas conservan este ajuste, pero no bloquean.

Los ajustes booleanos anteriores de las paredes siguen siendo compatibles; los modos explícitos por canal tienen prioridad. Las paredes guardadas sin dirección usan Ambos lados de forma predeterminada. La importación admite Neutral Scene 0.1–0.10 y acepta etiquetas direccionales explícitas con sus extremos ordenados en todas esas versiones; rechaza valores de dirección desconocidos. Las restricciones limitadas requieren la versión 0.9 o posterior. La vista previa de importación cuenta cada pared con un modo limitado una sola vez, aunque lo utilicen varios canales.

BRAMA conserva las coordenadas fraccionarias de la escena en las consultas geométricas sin redondearlas a píxeles enteros. El movimiento determina el lado de origen a partir del centro de la ficha al iniciar el desplazamiento y después comprueba el barrido del rectángulo alineado con los ejes definido por su anchura y altura. Esta superficie puede colisionar aunque la trayectoria del punto central esté libre; el movimiento y la visibilidad puntual siguen contratos distintos.

La importación de escenas admite una única entrada de detección redundante `basicSight` solo si tanto esta como la visión están activadas, su alcance coincide con los metadatos de visión y no contiene campos adicionales. Los demás modos de detección y las discrepancias siguen sin admitirse.

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

Las consultas puntuales ignoran una pared cuando su origen está exactamente sobre la recta que la contiene, incluida su prolongación más allá de cualquiera de sus extremos, incluso con Ambos lados. El movimiento direccional también ignora esa pared cuando el centro inicial de la ficha está exactamente sobre esa recta. En este caso, el movimiento con Ambos lados conserva la comprobación de colisión de la superficie rectangular. Las coordenadas fraccionarias cercanas no se redondean hacia la recta.

La visibilidad de un token comprueba su centro y puntos dentro de su cuerpo circular dibujado: un token parcialmente expuesto puede ser visible aunque su centro esté detrás de una pared. El muestreo se adapta al tamaño del token y se limita a 257 puntos; aún puede pasar por alto una abertura estrecha entre ellos. Las esquinas del marco de selección, las etiquetas y los contornos no conceden visibilidad. La ocultación de tokens y los permisos de propiedad se comprueban por separado. La niebla oculta el mapa visualmente; la geometría de la escena y las imágenes de fondo siguen enviándose a los jugadores y no son confidenciales.

BRAMA es una aplicación funcional en una etapa temprana. No implementa un reglamento completo, scripts sin restricciones, fusión colaborativa de texto, importación y exportación completa de diarios externos, marcadores de mapa, páginas de audio/vídeo/PDF ni alojamiento público. Las reglas importadas no compatibles se notifican o rechazan; no se ejecutan silenciosamente. La visión y la edición móvil tienen límites explícitos. Las pruebas correctas demuestran los contratos probados, no compatibilidad universal ni todos los escenarios posibles.

Las paredes limitadas que se cruzan tienen un límite de representación conservador: la visibilidad de un punto cuenta un cruce coincidente una vez, mientras que la máscara recorta el rayo exacto de anchura cero en la intersección para impedir que abra una cuña visible más amplia. El cálculo está limitado a 32 768 comparaciones de pares de paredes y 2 048 intersecciones. Superar cualquiera de los límites hace que las paredes limitadas actúen como normales solo en esa máscara. Esto puede ocultar zonas que deberían verse; nunca se descartan obstáculos y la visibilidad puntual conserva su regla de cruces limitados.

## Autor y permisos

Creado y mantenido por **CrioMant / [CrioNIK](https://github.com/CrioNIK)**. Solicita permiso comercial mediante el formulario **Commercial permission** del repositorio. Indica el uso previsto, el modelo de distribución y la organización. Abrir una solicitud no concede permiso: espera un acuerdo explícito por escrito.

Copyright © 2026 CrioMant. El código y los recursos originales de BRAMA se rigen por la [licencia](LICENSE.md). Los avisos y licencias de dependencias siguen aplicándose a sus respectivos componentes.
