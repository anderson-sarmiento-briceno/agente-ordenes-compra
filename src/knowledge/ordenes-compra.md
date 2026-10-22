# Proceso de órdenes de compra (OC)

## Flujo correcto
Solicitud → aprobación del líder → cotización → **OC en SAP** → recepción → factura → pago.
La OC debe existir **antes** de la factura. Si la factura llega primero, la compra es **retroactiva**.

## Paquete de cada solicitud
- `correo.json`: correo de entrada (id, remitente, asunto, fecha).
- `solicitud.json`: la solicitud (Excel normalizado): proveedor, centro de costo, subárea, cantidad, valor unitario, valor total, moneda, IVA y condiciones de pago (estos dos pueden faltar).
- `cotizacion.txt`: cotización del proveedor (precios con IVA incluido).
- `aprobacion.json`: correo del líder; debe decir "Aprobado".
- `factura.txt`: solo existe si la compra fue retroactiva.

## Reglas de control
| Regla | Qué verifica | Si no se cumple |
|---|---|---|
| RC1 | Proveedor existe (por NIT o, sin NIT, por nombre) y está activo | Bloqueo |
| RC2 | Aprobación existe, dice "Aprobado" y la envió un aprobador del centro de costo | Bloqueo |
| RC3 | Valor total ≤ tope del aprobador en ese centro | Bloqueo |
| RC4 | La subárea pertenece al centro de costo | Bloqueo |
| RC5 | Cotización y solicitud difieren máximo 2 % | Confirmación (mostrar ambos valores) |
| RC6 | Indicador de IVA ausente: se toma el del proveedor | Derivado + confirmación |
| RC7 | Condición de pago ausente: se toma la del proveedor | Derivado (solo informar) |
| RC8 | Factura anterior a la solicitud: compra retroactiva | Confirmación + marca retroactiva |
| RC9 | Aprobación con fecha anterior a la solicitud | Confirmación |
| RC10 | cantidad × valor unitario = valor total (±1) | Bloqueo |

- **Bloqueo**: la OC no se crea. Se informa la razón y la acción sugerida para el solicitante.
- **Confirmación**: la OC solo se crea si la analista confirma explícitamente.
- **Derivado**: valor completado desde los maestros; se informa siempre.

## Glosario
- **Centro de costo / subárea**: dónde se imputa el gasto.
- **Indicador de IVA**: C0 excluido, C1 19 %, C2 5 %.
- **Condiciones de pago**: Z000 inmediato, Z015/Z030/Z060 días fecha factura.
- **Idempotencia**: pedir dos veces la OC de la misma solicitud devuelve el mismo número; nunca se duplica.
