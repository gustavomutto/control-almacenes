/* Varias facturas abiertas a la vez.
 *
 * El mostrador real: un cliente no se decide y entra otro que sí. Con «Nueva factura» la que
 * está en pantalla pasa sola a espera —sin preguntar nada— y queda una hoja en blanco para el
 * siguiente. Arriba quedan las dos como pestañas y se salta de una a otra con un clic.
 *
 * Además, lo que está en pantalla se va guardando en el mismo equipo: recargar la página,
 * cambiar de pestaña o que se cierre el navegador no borra la venta.
 *
 * Nada de esto es una factura todavía: no hay número, no se descuenta inventario y no entra a
 * caja ni a los reportes hasta que se cobra.
 */
window.Espera = (function () {
  const nf = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
  const pesos = (v) => '$ ' + nf.format(Math.round(Number(v) || 0));
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function init(cfg) {
    const caja = document.querySelector(cfg.contenedor);
    if (!caja) return { autoguardar() {}, alCobrar() {} };

    const esVenta = cfg.tipo === 'factura';
    const PALABRA = esVenta ? 'factura' : 'cotización';
    const clave = `espera:${cfg.tipo}:${cfg.almacenId}`;

    let lista = [];
    let temporizador = null;
    let avisoTexto = '';
    // Cuando ya se cobró no hay que volver a guardar: si no, al salir de la página el
    // guardado automático revivía una factura que ya estaba emitida.
    let cerrado = false;

    // ---------- Lo que está en pantalla (se guarda en este equipo) ----------
    function guardarLocal() {
      if (cerrado) return;
      try {
        const estado = cfg.estado();
        if (!estado || !estado.lineas) localStorage.removeItem(clave);
        else localStorage.setItem(clave, JSON.stringify({ datos: estado.datos, guardado: Date.now() }));
      } catch (err) {
        /* navegación privada o almacenamiento lleno: no es motivo para romper la venta */
      }
    }

    function autoguardar() {
      pintarActual();
      clearTimeout(temporizador);
      temporizador = setTimeout(guardarLocal, 400);
    }

    function limpiarLocal() {
      clearTimeout(temporizador);
      try {
        localStorage.removeItem(clave);
      } catch (err) {}
    }

    function recuperarLocal() {
      let guardado = null;
      try {
        guardado = JSON.parse(localStorage.getItem(clave) || 'null');
      } catch (err) {
        return;
      }
      if (!guardado || !guardado.datos) return;
      cfg.cargar(guardado.datos);
      const estado = cfg.estado();
      if (estado && estado.lineas) avisar(`Se recuperó la ${PALABRA} que estabas haciendo.`);
      else limpiarLocal();
    }

    // ---------- Las que están en espera (viven en el servidor) ----------
    async function pedir(url, opciones) {
      const r = await fetch(url, opciones);
      const datos = await r.json();
      if (!datos.ok) throw new Error(datos.error || 'No se pudo completar la operación.');
      return datos;
    }

    async function refrescar() {
      try {
        const datos = await pedir(`/almacen/borradores?tipo=${cfg.tipo}`);
        lista = datos.borradores;
        pintar();
      } catch (err) {
        /* sin conexión: la lista se queda como esté */
      }
    }

    // El nombre sale solo: el del cliente si ya lo escribieron, y si no la hora.
    function nombreAutomatico(estado) {
      const hora = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
      return (estado && estado.nombre) || `${esVenta ? 'Venta' : 'Cotización'} ${hora}`;
    }

    function etiquetaActual() {
      const estado = cfg.estado();
      if (!estado || !estado.lineas) return `${esVenta ? 'Venta' : 'Cotización'} nueva`;
      return `${estado.nombre || 'Sin nombre'} · ${pesos(estado.total)}`;
    }

    function pintar() {
      caja.innerHTML = `
        <div class="espera-barra">
          <button class="btn linea mini" type="button" data-nueva>+ Nueva ${PALABRA}</button>
          <span class="espera-titulo">abiertas</span>
          <div class="espera-lista">
            <span class="espera-chip actual"><b data-actual>${esc(etiquetaActual())}</b></span>
            ${lista
              .map(
                (b) => `<span class="espera-chip" title="Abierta por ${esc(b.vendedor || '')}">
                    <button type="button" data-abrir="${b.id}">${esc(b.nombre)} · ${pesos(b.total)}</button>
                    <button type="button" class="espera-x" data-borrar="${b.id}" title="Borrar">×</button>
                  </span>`
              )
              .join('')}
          </div>
          <span class="espera-aviso">${esc(avisoTexto)}</span>
        </div>`;
    }

    // Solo el texto de la pestaña abierta, para no redibujar la barra con cada tecla.
    function pintarActual() {
      const act = caja.querySelector('[data-actual]');
      if (act) act.textContent = etiquetaActual();
    }

    // El aviso se guarda aparte porque la barra se redibuja al cambiar la lista.
    function avisar(texto) {
      avisoTexto = texto;
      const aviso = caja.querySelector('.espera-aviso');
      if (aviso) aviso.textContent = texto;
      setTimeout(() => {
        if (avisoTexto !== texto) return;
        avisoTexto = '';
        const act = caja.querySelector('.espera-aviso');
        if (act) act.textContent = '';
      }, 6000);
    }

    // Guarda lo que hay en pantalla y deja la caja libre. No pregunta nada.
    async function guardarEnEspera() {
      const estado = cfg.estado();
      if (!estado || !estado.lineas) return true; // no hay nada que guardar

      const nombre = nombreAutomatico(estado);
      try {
        await pedir('/almacen/borradores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tipo: cfg.tipo,
            nombre,
            datos: estado.datos,
            total: estado.total,
            lineas: estado.lineas,
          }),
        });
      } catch (err) {
        alert('No se pudo dejar en espera: ' + err.message);
        return false;
      }

      cfg.limpiar();
      limpiarLocal();
      return nombre;
    }

    async function nueva() {
      const estado = cfg.estado();
      if (!estado || !estado.lineas) {
        avisar(`Ya estás en una ${PALABRA} nueva.`);
        if (cfg.foco) cfg.foco();
        return;
      }
      const nombre = await guardarEnEspera();
      if (nombre === false) return;
      await refrescar();
      avisar(`La ${PALABRA} de ${nombre} quedó en espera. Puedes atender al siguiente cliente.`);
      if (cfg.foco) cfg.foco();
    }

    async function abrir(id) {
      const actual = cfg.estado();
      // Lo que está en pantalla nunca se pierde: primero se deja en espera.
      if (actual && actual.lineas && (await guardarEnEspera()) === false) return;

      try {
        const datos = await pedir(`/almacen/borradores/${id}/abrir`, { method: 'POST' });
        cfg.cargar(datos.borrador.datos);
        guardarLocal();
        await refrescar();
        avisar(`Retomaste la ${PALABRA} de ${datos.borrador.nombre}.`);
      } catch (err) {
        alert(err.message);
        refrescar();
      }
    }

    async function borrar(id) {
      const fila = lista.find((b) => String(b.id) === String(id));
      if (!confirm(`¿Borrar la ${PALABRA} en espera de "${fila ? fila.nombre : ''}"? No se puede deshacer.`)) return;
      try {
        await pedir(`/almacen/borradores/${id}/eliminar`, { method: 'POST' });
      } catch (err) {
        alert(err.message);
      }
      refrescar();
    }

    caja.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-nueva')) nueva();
      else if (b.dataset.abrir) abrir(b.dataset.abrir);
      else if (b.dataset.borrar) borrar(b.dataset.borrar);
    });

    // Al cerrar la pestaña se guarda de una vez, sin esperar al temporizador.
    window.addEventListener('beforeunload', guardarLocal);

    function alCobrar() {
      cerrado = true;
      limpiarLocal();
    }

    pintar();
    recuperarLocal();
    refrescar();

    return { autoguardar, alCobrar, refrescar, nueva };
  }

  return { init };
})();
