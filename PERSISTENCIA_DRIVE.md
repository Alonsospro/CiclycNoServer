# Estado operativo persistente en Drive

La integración está preparada pero permanece desactivada hasta configurar y probar el servicio remoto. No cambia el almacenamiento de las fotos y archivos finales que ya utiliza Apps Script.

## Destino y privacidad

Carpeta elegida: [PERSISTENCIA](https://drive.google.com/drive/folders/1wFLtH6Cb9chLcyc4w-5MBYQYpzdSXNN6).

Se detectó acceso de edición para cualquiera con el enlace. Antes de cargar estado, seleccionar **Compartir → Acceso general → Restringido → Guardar**. Crear dentro una subcarpeta **Estado de la aplicación** y usar su ID. No compartir públicamente la subcarpeta: incluye hashes de contraseñas de usuarios, conteos y auditoría. Nunca guardar el token en GitHub, HTML o Google Docs.

## Publicar el servicio

1. Crear un proyecto **separado** en Apps Script. Copiar únicamente `gas/StateStore.gs` al archivo `Code.gs`. No añadirlo al proyecto existente: ambos tienen su propia función `doPost`.
2. En **Configuración del proyecto → Propiedades del script**, definir `DRIVE_STATE_FOLDER_ID` con el ID de la subcarpeta y `DRIVE_STATE_TOKEN` con una clave aleatoria de al menos 32 caracteres. Por ejemplo, generar una clave local con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Copiarla a las propiedades del script y al archivo privado `.env`, sin enviarla por chat.
3. Implementar como **Aplicación web**, ejecutar como el propietario de la carpeta y permitir que el servidor acceda al endpoint. El servicio exige el token en cada POST; no expone el estado mediante GET. Autorizar el acceso de Apps Script a Drive y copiar la URL `/exec` a `DRIVE_STATE_URL`.
4. Mantener **un solo proyecto de Apps Script** como escritor del estado. Su bloqueo serializa la validación y publicación de transacciones. Todos los despliegues de Vercel deben usar el mismo endpoint.

## Comprobar y activar

En `.env` y posteriormente en las variables del proyecto de Vercel:

```dotenv
STORAGE_BACKEND=drive
DRIVE_STATE_URL=https://script.google.com/macros/s/ID_IMPLEMENTACION/exec
DRIVE_STATE_TOKEN=CLAVE_PRIVADA
```

Primero probar localmente con `node scripts/check-drive-state.js`. La comprobación lee el estado sin modificarlo. Un fallo de autenticación, red o permisos produce un error; no cambia al disco temporal como respaldo silencioso.

Antes de activar en producción, detener los nuevos conteos y obtener un respaldo verificado del estado operativo actual. Un despliegue puede perder los archivos temporales actuales; no activar sobre una carpeta vacía mientras haya inventarios en curso sin migrar. `node scripts/migrate-drive-state.js <carpeta-de-respaldo-verificada>` importa JSON únicamente a un destino vacío y comprueba su lectura posterior. No asumir que `data/` del repositorio contiene el estado actual de Vercel. No reconstruir conteos ni pertenencias a cierres por suposiciones.

Probar en un entorno de vista previa separado antes del cambio de producción. Un preview con el mismo endpoint y token modifica los mismos datos de producción: usar un proyecto de Apps Script y carpeta de prueba diferentes.

Al activar en Vercel, habilitar Fluid Compute y ajustar el límite de función a 180 segundos o más, dentro de los límites del plan. La aplicación añade lecturas/confirmaciones de Drive y sincronización con Sheets. El cliente usa un tiempo de espera de 60 segundos; si expira debe conservar la misma operación para reintentar. Validar tiempos reales antes de habilitar operadores.

## Garantías y límites de esta primera versión

- El estado de cada petición se lee de Drive y se aísla del de otras peticiones. El disco temporal no es la fuente de inventarios, usuarios, justificaciones, historial, auditoría, papelera, eliminaciones ni cola de sincronización.
- Cada documento tiene una versión. Una escritura basada en una versión antigua se rechaza con `STATE_CONFLICT` (HTTP 409); el operador debe actualizar y revisar antes de reenviar. No fusiona silenciosamente dos conteos sobre la misma fila.
- Primero se guardan inventario, auditoría, recibo de operación y cola pendiente; después se intenta entregar el conteo a Sheets. Una caída de Sheets deja el trabajo en Drive. La lectura del inventario o el siguiente conteo vuelve a intentar la cola, respetando su reserva temporal.
- Los documentos de una transacción son inmutables. Se publica un único manifiesto después de guardar todos; un fallo anterior conserva el estado previo. Las eliminaciones conservan versión para impedir que un cliente antiguo resucite un archivo.
- El éxito HTTP espera la confirmación de Drive. Si la respuesta se pierde, los conteos conservan su identificador de operación para evitar duplicados al reintentar.
- Primera versión: descarga el estado completo, con límite de 8 MB de documentos y 500 cambios por transacción. Requiere medir tamaño y latencia para el volumen real. Las revisiones anteriores y los archivos huérfanos se conservan; todavía no hay limpieza automática.
- Drive y Apps Script tienen latencia y cuotas. No elimina errores de conectividad ni impide que Vercel reinicie una instancia; permite recuperar el estado confirmado después de ese reinicio.
- Cambiar `STORAGE_BACKEND` a `local` no descarga los datos de Drive. Una reversión necesita exportar y verificar el estado primero.

## Validación

`npm test` y `npm run build`. Las pruebas remotas usan Apps Script simulado y cubren arranque sin disco, conflictos, múltiples inventarios, reintentos, transacciones fallidas, eliminaciones, autenticación, fallo HTTP de persistencia y guardado de cola antes de Sheets. La activación requiere además una prueba real con el endpoint y carpeta configurados.
