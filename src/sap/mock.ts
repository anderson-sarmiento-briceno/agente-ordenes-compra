// SAP simulado sobre archivos: cada OC es una línea de out/sap/ordenes.jsonl.
// Numeración secuencial desde 4500000001. Idempotente por solicitud_id.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cargarMaestros, normalizarNit } from "../datos.js";
import type { OrdenCompra } from "../payload.js";
import type { SapAdapter } from "./adapter.js";

interface RegistroOC {
  numero_oc: string;
  fecha: string;
  orden: OrdenCompra;
}

const PRIMER_NUMERO = 4500000001;

export class SapMock implements SapAdapter {
  private readonly archivo: string;

  constructor(private readonly raiz: string) {
    const dir = join(raiz, "out", "sap");
    mkdirSync(dir, { recursive: true });
    this.archivo = join(dir, "ordenes.jsonl");
  }

  listar(): RegistroOC[] {
    if (!existsSync(this.archivo)) return [];
    return readFileSync(this.archivo, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as RegistroOC);
  }

  async consultarProveedor(nit: string) {
    const p = cargarMaestros(this.raiz).proveedores.find((x) => normalizarNit(x.nit) === normalizarNit(nit));
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null;
  }

  async buscarOrdenPorReferencia(solicitud_id: string) {
    const r = this.listar().find((o) => o.orden.referencia.solicitud_id === solicitud_id);
    return r ? { numero_oc: r.numero_oc } : null;
  }

  async crearOrden(orden: OrdenCompra) {
    // Idempotencia también aquí: el adaptador nunca duplica una referencia.
    const existente = this.listar().find((o) => o.orden.referencia.solicitud_id === orden.referencia.solicitud_id);
    if (existente) return { numero_oc: existente.numero_oc, fecha: existente.fecha };

    const registro: RegistroOC = {
      numero_oc: String(PRIMER_NUMERO + this.listar().length),
      fecha: new Date().toISOString(),
      orden,
    };
    appendFileSync(this.archivo, JSON.stringify(registro) + "\n");
    return { numero_oc: registro.numero_oc, fecha: registro.fecha };
  }
}
