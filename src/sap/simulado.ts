// SAP simulado: guarda las órdenes de compra (OC) en memoria.
// En producción esta clase se reemplaza por un adaptador real (BAPI o OData)
// que cumpla la misma interfaz `AdaptadorSap`; el resto del código no cambia.

export interface PosicionOC {
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  valor: number;
}

export interface DatosOC {
  solicitudId: string; // también sirve como clave de idempotencia
  nitProveedor: string;
  centroCosto: string;
  subarea: string;
  indicadorIva: string;
  condicionPago: string;
  posiciones: PosicionOC[];
  subtotal: number;
  iva: number;
  total: number;
  retroactiva: boolean;
}

export interface OrdenCompra extends DatosOC {
  numero: string;
  creadaEn: string;
}

export interface AdaptadorSap {
  crearOrdenCompra(datos: DatosOC): { oc: OrdenCompra; yaExistia: boolean };
  buscarPorSolicitud(solicitudId: string): OrdenCompra | undefined;
  listar(): OrdenCompra[];
}

class SapSimulado implements AdaptadorSap {
  private ordenes = new Map<string, OrdenCompra>(); // clave: solicitudId
  private consecutivo = 4500000000; // SAP numera las OC desde 45xxxxxxxx

  crearOrdenCompra(datos: DatosOC) {
    // Idempotencia: si ya hay OC para esta solicitud, se devuelve la misma.
    const existente = this.ordenes.get(datos.solicitudId);
    if (existente) return { oc: existente, yaExistia: true };

    this.consecutivo += 1;
    const oc: OrdenCompra = {
      ...datos,
      numero: String(this.consecutivo),
      creadaEn: new Date().toISOString(),
    };
    this.ordenes.set(datos.solicitudId, oc);
    return { oc, yaExistia: false };
  }

  buscarPorSolicitud(solicitudId: string) {
    return this.ordenes.get(solicitudId);
  }

  listar() {
    return [...this.ordenes.values()];
  }
}

// Una sola instancia compartida por todo el proceso.
export const sap: AdaptadorSap = new SapSimulado();
