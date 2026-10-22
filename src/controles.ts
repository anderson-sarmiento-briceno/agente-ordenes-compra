// Reglas de control RC1–RC10 (sección 7.3 del PRD).
// Funciones PURAS: mismo paquete + mismos maestros -> mismo resultado. No usan el LLM.
import { normalizarNit, normalizarNombre, type Maestros, type Paquete, type Proveedor } from "./datos.js";

export type Regla = "RC1" | "RC2" | "RC3" | "RC4" | "RC5" | "RC6" | "RC7" | "RC8" | "RC9" | "RC10";
export type Estado = "ok" | "bloqueo" | "confirmacion" | "derivado";

export interface Hallazgo {
  regla: Regla;
  detalle: string;
  accion?: string; // acción sugerida al humano
}

export interface Derivado {
  valor: string;
  fuente: string; // de dónde salió, p. ej. "maestro.proveedores"
  detalle: string;
}

export interface Validacion {
  apta: boolean; // sin bloqueos
  bloqueos: Hallazgo[];
  confirmaciones: Hallazgo[];
  derivados: Record<string, Derivado>;
  retroactiva: boolean;
  controles: { regla: Regla; estado: Estado; detalle: string }[]; // una fila por regla (matriz)
}

const TOLERANCIA_COTIZACION = 0.02; // RC5: 2 %
const pesos = (n: number) => "$" + n.toLocaleString("es-CO");
const soloFecha = (iso: string) => iso.slice(0, 10);

export function buscarProveedor(paquete: Paquete, maestros: Maestros): { proveedor: Proveedor | undefined; por: "nit" | "nombre" } {
  const { proveedor_nit, proveedor_nombre } = paquete.solicitud;
  if (proveedor_nit) {
    const nit = normalizarNit(proveedor_nit);
    return { proveedor: maestros.proveedores.find((p) => normalizarNit(p.nit) === nit), por: "nit" };
  }
  const nombre = normalizarNombre(proveedor_nombre);
  return { proveedor: maestros.proveedores.find((p) => normalizarNombre(p.nombre) === nombre), por: "nombre" };
}

export function validar(paquete: Paquete, maestros: Maestros): Validacion {
  const s = paquete.solicitud;
  const bloqueos: Hallazgo[] = [];
  const confirmaciones: Hallazgo[] = [];
  const derivados: Record<string, Derivado> = {};
  const controles: Validacion["controles"] = [];

  const ok = (regla: Regla, detalle: string) => controles.push({ regla, estado: "ok", detalle });
  const bloquear = (regla: Regla, detalle: string, accion: string) => {
    bloqueos.push({ regla, detalle, accion });
    controles.push({ regla, estado: "bloqueo", detalle });
  };
  const confirmar = (regla: Regla, detalle: string) => {
    confirmaciones.push({ regla, detalle });
    controles.push({ regla, estado: "confirmacion", detalle });
  };
  const derivar = (regla: Regla, campo: string, d: Derivado) => {
    derivados[campo] = d;
    controles.push({ regla, estado: "derivado", detalle: d.detalle });
  };

  // RC1 · Proveedor existe (por NIT; si no hay NIT, por nombre normalizado) y está activo
  const { proveedor, por } = buscarProveedor(paquete, maestros);
  const idProveedor = por === "nit" ? `NIT ${s.proveedor_nit}` : `"${s.proveedor_nombre}" (sin NIT, buscado por nombre)`;
  if (!proveedor)
    bloquear("RC1", `El proveedor ${idProveedor} no existe en el maestro de proveedores.`,
      "Solicitar a compras la creación del proveedor en SAP o corregir el NIT en la solicitud.");
  else if (!proveedor.activo)
    bloquear("RC1", `El proveedor ${proveedor.nombre} está INACTIVO.`, "Pedir la reactivación del proveedor o elegir otro proveedor.");
  else ok("RC1", `${proveedor.nombre} (código SAP ${proveedor.codigo_sap}) existe y está activo; encontrado por ${por}.`);
  if (proveedor && por === "nombre")
    derivados.proveedor_nit = { valor: proveedor.nit, fuente: "maestro.proveedores", detalle: `NIT ${proveedor.nit} tomado del maestro (la solicitud no lo trae).` };

  // RC4 · La subárea pertenece al centro de costo (se evalúa antes porque RC2 y RC3 dependen del centro)
  const centro = maestros.centrosCosto.find((c) => c.centro_costo === s.centro_costo);

  // RC2 · Aprobación existe, dice "Aprobado" y viene de un aprobador del centro de costo
  const ap = paquete.aprobacion;
  const aprobador = centro?.aprobadores.find((a) => a.email.toLowerCase() === ap?.de.toLowerCase());
  const listaAprobadores = centro?.aprobadores.map((a) => `${a.nombre} <${a.email}> (tope ${pesos(a.tope)})`).join(", ") ?? "";
  if (!ap) bloquear("RC2", "No hay correo de aprobación en el paquete.", "Pedir al solicitante el correo de aprobación del líder.");
  else if (!ap.aprobado) bloquear("RC2", "El correo de aprobación no contiene \"Aprobado\".", "Pedir al líder una aprobación explícita.");
  else if (!centro) bloquear("RC2", `No se puede verificar el aprobador: el centro ${s.centro_costo} no existe.`, "Corregir el centro de costo.");
  else if (!aprobador)
    bloquear("RC2", `${ap.de} no es aprobador del centro ${centro.centro_costo} (${centro.nombre}).`,
      `Solicitar la aprobación a un aprobador de ${centro.centro_costo}: ${listaAprobadores}.`);
  else ok("RC2", `Aprobado por ${aprobador.nombre}, aprobador de ${centro.centro_costo}.`);

  // RC3 · valor_total <= tope del aprobador para ese centro
  if (aprobador) {
    if (s.valor_total > aprobador.tope)
      bloquear("RC3", `${pesos(s.valor_total)} supera el tope de ${aprobador.nombre} (${pesos(aprobador.tope)}).`,
        `Pedir aprobación a alguien con tope suficiente en ${s.centro_costo}.`);
    else ok("RC3", `${pesos(s.valor_total)} está dentro del tope de ${aprobador.nombre} (${pesos(aprobador.tope)}).`);
  } else if (centro) {
    const maxTope = Math.max(0, ...centro.aprobadores.map((a) => a.tope));
    if (s.valor_total > maxTope)
      bloquear("RC3", `${pesos(s.valor_total)} supera el tope de TODOS los aprobadores de ${centro.centro_costo} (máximo ${pesos(maxTope)}).`,
        "Escalar a un nivel de aprobación superior o revisar si el centro de costo es el correcto.");
    else ok("RC3", `No evaluable contra el aprobador (RC2), pero existe en ${centro.centro_costo} un aprobador con tope suficiente.`);
  } else bloquear("RC3", "No se puede verificar el tope: centro de costo inexistente.", "Corregir el centro de costo.");

  // RC4 · subárea pertenece al centro
  if (!centro) bloquear("RC4", `El centro de costo ${s.centro_costo} no existe.`, "Corregir el centro de costo en la solicitud.");
  else if (!centro.subareas.includes(s.subarea))
    bloquear("RC4", `La subárea "${s.subarea}" no pertenece a ${centro.centro_costo} (${centro.subareas.join(", ")}).`, "Corregir la subárea.");
  else ok("RC4", `${s.subarea} pertenece a ${centro.centro_costo} ${centro.nombre}.`);

  // RC5 · |cotización.total − solicitud.valor_total| / valor_total <= 2 %
  const cot = paquete.cotizacion;
  if (!cot) confirmar("RC5", "No hay cotización legible en el paquete. ¿Confirmas crear la OC sin cotización?");
  else {
    const desvio = s.valor_total === 0 ? 1 : Math.abs(cot.total - s.valor_total) / s.valor_total;
    if (desvio > TOLERANCIA_COTIZACION)
      confirmar("RC5", `La cotización (${pesos(cot.total)}) difiere ${(desvio * 100).toFixed(1)} % de la solicitud (${pesos(s.valor_total)}); el máximo es 2 %.`);
    else ok("RC5", `Cotización ${pesos(cot.total)} vs solicitud ${pesos(s.valor_total)}: diferencia ${(desvio * 100).toFixed(1)} %.`);
  }

  // RC6 · indicador_iva ausente -> se deriva del proveedor y se pide confirmación
  if (s.indicador_iva) {
    const iva = maestros.indicadoresIva.find((i) => i.codigo === s.indicador_iva);
    if (!iva) bloquear("RC6", `El indicador de IVA "${s.indicador_iva}" no existe en el maestro.`, "Corregir el indicador de IVA.");
    else ok("RC6", `Indicador ${iva.codigo} (${iva.descripcion}) informado en la solicitud.`);
  } else if (proveedor) {
    derivar("RC6", "indicador_iva", {
      valor: proveedor.indicador_iva_default,
      fuente: "maestro.proveedores",
      detalle: `IVA no informado: se usa el default del proveedor (${proveedor.indicador_iva_default}).`,
    });
    confirmaciones.push({ regla: "RC6", detalle: `La solicitud no trae indicador de IVA; se derivó ${proveedor.indicador_iva_default} del proveedor. ¿Lo confirmas?` });
  } else confirmar("RC6", "La solicitud no trae indicador de IVA y no se puede derivar (proveedor no encontrado).");

  // RC7 · condiciones_pago ausente -> se deriva del proveedor (solo se informa)
  if (s.condiciones_pago) {
    const cp = maestros.condicionesPago.find((c) => c.codigo === s.condiciones_pago);
    if (!cp) bloquear("RC7", `La condición de pago "${s.condiciones_pago}" no existe en el maestro.`, "Corregir la condición de pago.");
    else ok("RC7", `Condición ${cp.codigo} (${cp.descripcion}) informada en la solicitud.`);
  } else if (proveedor)
    derivar("RC7", "condiciones_pago", {
      valor: proveedor.condiciones_pago_default,
      fuente: "maestro.proveedores",
      detalle: `Condición de pago no informada: se usa la del proveedor (${proveedor.condiciones_pago_default}).`,
    });
  else ok("RC7", "No evaluable: proveedor no encontrado (ver RC1).");

  // RC8 · factura con fecha anterior a fecha_solicitud -> retroactiva + confirmación
  const fac = paquete.factura;
  const retroactiva = !!fac && fac.fecha < s.fecha_solicitud;
  if (retroactiva)
    confirmar("RC8", `Compra RETROACTIVA: la factura ${fac.numero} es del ${fac.fecha}, anterior a la solicitud (${s.fecha_solicitud}). Se registrará retroactiva = true.`);
  else ok("RC8", fac ? `Hay factura ${fac.numero} del ${fac.fecha}, no anterior a la solicitud.` : "No hay factura previa.");

  // RC9 · fecha de aprobación >= fecha_solicitud
  if (ap && soloFecha(ap.fecha) < s.fecha_solicitud)
    confirmar("RC9", `La aprobación (${soloFecha(ap.fecha)}) es anterior a la solicitud (${s.fecha_solicitud}).`);
  else ok("RC9", ap ? `Aprobación del ${soloFecha(ap.fecha)} posterior o igual a la solicitud (${s.fecha_solicitud}).` : "Sin aprobación (ver RC2).");

  // RC10 · cantidad × valor_unitario = valor_total (± 1)
  const calculado = s.cantidad * s.valor_unitario;
  if (Math.abs(calculado - s.valor_total) > 1)
    bloquear("RC10", `${s.cantidad} × ${pesos(s.valor_unitario)} = ${pesos(calculado)}, pero valor_total es ${pesos(s.valor_total)}.`,
      "Pedir al solicitante corregir cantidades o valores en la solicitud.");
  else ok("RC10", `${s.cantidad} × ${pesos(s.valor_unitario)} = ${pesos(s.valor_total)}.`);

  const orden: Regla[] = ["RC1", "RC2", "RC3", "RC4", "RC5", "RC6", "RC7", "RC8", "RC9", "RC10"];
  controles.sort((a, b) => orden.indexOf(a.regla) - orden.indexOf(b.regla));
  return { apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, retroactiva, controles };
}
