// Controles de validación de una solicitud de compra.
// Funciones PURAS: mismos datos de entrada -> mismo resultado, siempre.
// No llaman al LLM ni a SAP. Por eso demo.ts puede correrlos sin Claude.
// >>> El día de la prueba, AJUSTAR la lista de controles a las reglas del PRD. <<<
import type { ExpedienteSolicitud, Maestros } from "./datos.js";
import type { DatosOC } from "./sap/simulado.js";

export type Estado = "OK" | "FALLA" | "ALERTA";

export interface ResultadoControl {
  codigo: string; // C01, C02, ... (sirve para la matriz de controles)
  control: string; // nombre legible
  estado: Estado;
  detalle: string; // explicación: por qué pasó o falló
}

export interface Evaluacion {
  solicitudId: string;
  controles: ResultadoControl[];
  /** true si ningún control quedó en FALLA (las ALERTA no bloquean, pero se avisan). */
  apta: boolean;
  retroactiva: boolean;
  /** Datos listos para enviar a SAP (solo se usan si apta = true). */
  datosOC: DatosOC;
}

/** Convierte "$ 4.000.000" o "4.000.000,50" (formato colombiano) a número. */
export function parsearMonto(texto: string): number {
  const limpio = texto.replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".");
  return Number(limpio);
}

/** Busca "ETIQUETA: $ 1.234.567" en un texto libre (cotización o factura). */
function extraerMonto(texto: string, etiqueta: RegExp): number | null {
  const m = texto.match(new RegExp(etiqueta.source + String.raw`[^\d\n]*([\d.,]+)`, "i"));
  return m ? parsearMonto(m[1]) : null;
}

function extraerFecha(texto: string): string | null {
  const m = texto.match(/FECHA[^\d\n]*(\d{4}-\d{2}-\d{2})/i);
  return m ? m[1] : null;
}

const redondear = (n: number) => Math.round(n);
const pesos = (n: number) => "$" + n.toLocaleString("es-CO");

export function evaluarSolicitud(
  exp: ExpedienteSolicitud,
  maestros: Maestros,
  ocExistente: boolean,
): Evaluacion {
  const s = exp.solicitud;
  const controles: ResultadoControl[] = [];
  const agregar = (codigo: string, control: string, estado: Estado, detalle: string) =>
    controles.push({ codigo, control, estado, detalle });

  // ---- Datos de los maestros que vamos a necesitar ----
  const proveedor = maestros.proveedores.find((p) => p.nit === s.nitProveedor);
  const centro = maestros.centrosCosto.find((c) => c.codigo === s.centroCosto);
  const codigoIva = s.indicadorIva ?? proveedor?.indicadorIvaDefault ?? "";
  const iva = maestros.indicadoresIva.find((i) => i.codigo === codigoIva);
  const codigoPago = s.condicionPago ?? proveedor?.condicionPagoDefault ?? "";
  const pago = maestros.condicionesPago.find((c) => c.codigo === codigoPago);

  // ---- Cálculo de la OC (determinista) ----
  const posiciones = s.items.map((it) => ({
    ...it,
    valor: redondear(it.cantidad * it.precioUnitario),
  }));
  const subtotal = posiciones.reduce((acc, p) => acc + p.valor, 0);
  const valorIva = redondear(subtotal * (iva?.tasa ?? 0));
  const total = subtotal + valorIva;

  // C01 - Proveedor existe y está activo
  if (!proveedor) agregar("C01", "Proveedor activo", "FALLA", `El NIT ${s.nitProveedor} no existe en el maestro de proveedores.`);
  else if (proveedor.estado !== "ACTIVO")
    agregar("C01", "Proveedor activo", "FALLA", `${proveedor.nombre} está en estado ${proveedor.estado}.`);
  else agregar("C01", "Proveedor activo", "OK", `${proveedor.nombre} (NIT ${proveedor.nit}) está ACTIVO.`);

  // C02 - Centro de costo y subárea válidos
  if (!centro) agregar("C02", "Centro de costo y subárea", "FALLA", `El centro ${s.centroCosto} no existe.`);
  else if (!centro.subareas.includes(s.subarea))
    agregar("C02", "Centro de costo y subárea", "FALLA", `La subárea ${s.subarea} no pertenece a ${centro.codigo}.`);
  else agregar("C02", "Centro de costo y subárea", "OK", `${centro.codigo} ${centro.nombre} / ${s.subarea}.`);

  // C03 - Evidencia de aprobación del líder correcto
  const ap = exp.aprobacion;
  if (!ap.aprobado) agregar("C03", "Aprobación del líder", "FALLA", "La evidencia indica que la solicitud NO fue aprobada.");
  else if (!centro) agregar("C03", "Aprobación del líder", "FALLA", "No se puede verificar el líder: centro de costo inválido.");
  else if (ap.aprobador.toLowerCase() !== centro.lider.email.toLowerCase())
    agregar("C03", "Aprobación del líder", "FALLA", `Aprobó ${ap.aprobador}, pero el líder de ${centro.codigo} es ${centro.lider.email}.`);
  else agregar("C03", "Aprobación del líder", "OK", `Aprobada por ${centro.lider.nombre} el ${ap.fecha}.`);

  // C04 - Monto dentro del tope de aprobación del líder (se compara el total con IVA; confirmar con el PRD)
  if (!centro) agregar("C04", "Tope de aprobación", "FALLA", "No se puede verificar el tope: centro de costo inválido.");
  else if (total > centro.lider.topeAprobacion)
    agregar("C04", "Tope de aprobación", "FALLA", `Total ${pesos(total)} supera el tope de ${centro.lider.nombre} (${pesos(centro.lider.topeAprobacion)}).`);
  else agregar("C04", "Tope de aprobación", "OK", `Total ${pesos(total)} <= tope ${pesos(centro.lider.topeAprobacion)}.`);

  // C05 - Indicador de IVA válido
  if (!iva) agregar("C05", "Indicador de IVA", "FALLA", `El indicador "${codigoIva}" no existe.`);
  else agregar("C05", "Indicador de IVA", "OK", `${iva.codigo} (${iva.descripcion}): IVA ${pesos(valorIva)}.`);

  // C06 - Condición de pago válida (la de la solicitud o la default del proveedor)
  const origenPago = s.condicionPago ? "de la solicitud" : "default del proveedor";
  if (!pago) agregar("C06", "Condición de pago", "FALLA", `La condición "${codigoPago}" no existe.`);
  else agregar("C06", "Condición de pago", "OK", `${pago.codigo} - ${pago.descripcion} (${origenPago}).`);

  // C07 - Coherencia entre solicitud y cotización (NIT y subtotal)
  const subtotalCotizado = extraerMonto(exp.cotizacion, /SUBTOTAL/);
  if (!exp.cotizacion.includes(s.nitProveedor))
    agregar("C07", "Coherencia con cotización", "FALLA", `La cotización no menciona el NIT ${s.nitProveedor}.`);
  else if (subtotalCotizado === null)
    agregar("C07", "Coherencia con cotización", "FALLA", "No se encontró el SUBTOTAL en la cotización.");
  else if (Math.abs(subtotalCotizado - subtotal) > 1)
    agregar("C07", "Coherencia con cotización", "FALLA", `Subtotal solicitud ${pesos(subtotal)} ≠ cotización ${pesos(subtotalCotizado)}.`);
  else agregar("C07", "Coherencia con cotización", "OK", `Subtotal ${pesos(subtotal)} coincide con la cotización.`);

  // C08 - Compra retroactiva: la factura llegó antes que la OC/aprobación
  let retroactiva = false;
  if (exp.factura) {
    retroactiva = true;
    const fechaFactura = extraerFecha(exp.factura);
    const antesDeAprobar = fechaFactura !== null && fechaFactura < ap.fecha;
    agregar(
      "C08",
      "Compra retroactiva",
      "ALERTA",
      `Existe factura${fechaFactura ? ` del ${fechaFactura}` : ""}` +
        (antesDeAprobar ? `, ANTERIOR a la aprobación (${ap.fecha})` : "") +
        ". La compra se hizo antes de la OC: requiere revisión y se marcará como retroactiva.",
    );
  } else agregar("C08", "Compra retroactiva", "OK", "No hay factura previa: compra con OC antes de facturar.");

  // C09 - No duplicar OC
  if (ocExistente) agregar("C09", "OC no duplicada", "FALLA", `Ya existe una OC en SAP para ${s.id}.`);
  else agregar("C09", "OC no duplicada", "OK", "No hay OC previa para esta solicitud.");

  return {
    solicitudId: s.id,
    controles,
    apta: controles.every((c) => c.estado !== "FALLA"),
    retroactiva,
    datosOC: {
      solicitudId: s.id,
      nitProveedor: s.nitProveedor,
      centroCosto: s.centroCosto,
      subarea: s.subarea,
      indicadorIva: codigoIva,
      condicionPago: codigoPago,
      posiciones,
      subtotal,
      iva: valorIva,
      total,
      retroactiva,
    },
  };
}
