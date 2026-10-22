// Interfaz del adaptador SAP (obligatoria, sección 7.4 del PRD).
// La implementación simulada está en mock.ts; la real se diseña en SOLUCION.md.
import type { OrdenCompra } from "../payload.js";

export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>;
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>;
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>;
}
