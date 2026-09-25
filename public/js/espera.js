/* Ventas y cotizaciones «en espera».
 *
 * Resuelve dos formas de perder el trabajo:
 *   1. El cliente no se decide y llega otro: se guarda la venta a medio hacer en el servidor
 *      y la caja queda libre. Cualquier caja del mismo almacén puede retomarla.
 *   2. Se recarga la página, se va la luz o se cierra el navegador sin querer: lo que estaba
 *      en pantalla se recupera solo, porque se va guardando en el mismo equipo.
 *
 * Nada de esto es una factura: no hay número, no se descuenta inventario y no entra a
 * ningún reporte hasta que se cobra.
 */
window.Espera = (function () {
  const nf = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
  const pesos = (v) => '$ ' + nf.format(Math.round(Number(v) || 0));
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function init(cfg) {
    const caja = document.querySelector(cfg.contenedor);
    if (!caja) return { autoguardar() {}, alCobrar() {} };

    const clave = `espera:${cfg.tipo}:${cfg.almacenId}`;
    let lista = [];
    let temporizador = null;
    // Cuando la venta ya se cobró, no hay que volver a guardarla: si no, al salir de la
    // página el guardado automático la revivía y aparecía otra vez como pendiente.
    let cerrado = false;
    let avisoTexto = '';

    // ---------- Borrador local (este equipo) ----------
    function guardarLocal() {
      if (cerrado) return;
      try {
        const estado = cfg.estado();
        if (!estado || !estado.lineas) localStorage.removeItem(clave);
        else localStorage.setItem(clave, JSON.stringify({ datos: estado.datos, guardado: Date.now() }));
      } catch (err) {
        /* modo privado o almacenamiento lleno: no es motivo para romper la venta */
      }
    }

    function autoguardar() {
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
      if (estado && estado.lineas) {
        avisar(`Se recuperó ${cfg.tipo === 'factura' ? 'la venta' : 'la cotización'} que estabas haciendo.`);
      } else {
        limpiarLocal();
      }
    }

    // ---------- Lista en espera (servidor) ----------
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

    function pintar() {
      const etiqueta = cfg.tipo === 'factura' ? 'venta' : 'cotización';
      caja.innerHTML = `
        <div class="espera-barra">
          <button class="btn linea mini" type="button" data-guardar>Dejar esta ${etiqueta} en espera</button>
          <span class="espera-titulo">${lista.length ? 'En espera:' : ''}</span>
          <div class="espera-lista">
            ${lista
              .map(
                (b) => `<span class="espera-chip" title="${esc(b.vendedor || '')}">
                    <button type="button" data-abrir="${b.id}">${esc(b.nombre)} · ${pesos(b.total)}</button>
                    <button type="button" class="espera-x" data-borrar="${b.id}" title="Borrar">×</button>
                  </span>`
              )
              .join('')}
          </div>
          <span class="espera-aviso">${esc(avisoTexto)}</span>
        </div>`;
    }

    // El aviso se guarda en una variable porque la barra se vuelve a dibujar cuando
    // cambia la lista, y si no se perdería el mensaje que acaba de aparecer.
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

    // Guarda lo que hay en pantalla y deja la caja libre.
    async function guardarEnEspera({ silencioso = false } = {}) {
      const estado = cfg.estado();
      if (!estado || !estado.lineas) {
        if (!silencioso) alert('No hay nada que dejar en espera.');
        return false;
      }
      let nombre = estado.nombre;
      if (!silencioso || !nombre) {
        const sugerido = nombre || '';
        const escrito = prompt('¿A nombre de quién queda en espera?', sugerido);
        if (escrito === null) return false;
        nombre = escrito.trim() || sugerido || 'Sin nombre';
      }

      try {
        await pedir('/almacen/borradores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tipo: cfg.tipo, nombre, datos: estado.datos, total: estado.total, lineas: estado.lineas }),
        });
      } catch (err) {
        alert('No se pudo guardar en espera: ' + err.message);
        return false;
      }

      cfg.limpiar();
      limpiarLocal();
      await refrescar();
      avisar(`Guardada en espera a nombre de ${nombre}.`);
      return true;
    }

    async function abrir(id) {
      const actual = cfg.estado();
      // Nunca se pierde lo que hay en pantalla: primero se deja en espera.
      if (actual && actual.lineas) {
        const ok = await guardarEnEspera({ silencioso: true });
        if (!ok) return;
      }
      try {
        const datos = await pedir(`/almacen/borradores/${id}/abrir`, { method: 'POST' });
        cfg.cargar(datos.borrador.datos);
        guardarLocal();
        await refrescar();
        avisar(`Retomaste la ${cfg.tipo === 'factura' ? 'venta' : 'cotización'} de ${datos.borrador.nombre}.`);
      } catch (err) {
        alert(err.message);
        refrescar();
      }
    }

    async function borrar(id) {
      const fila = lista.find((b) => String(b.id) === String(id));
      if (!confirm(`¿Borrar la que está en espera de "${fila ? fila.nombre : ''}"? No se puede deshacer.`)) return;
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
      if (b.hasAttribute('data-guardar')) guardarEnEspera();
      else if (b.dataset.abrir) abrir(b.dataset.abrir);
      else if (b.dataset.borrar) borrar(b.dataset.borrar);
    });

    // Al cerrar la pestaña se guarda de una vez, sin esperar al temporizador.
    window.addEventListener('beforeunload', guardarLocal);

    pintar();
    recuperarLocal();
    refrescar();

    function alCobrar() {
      cerrado = true;
      limpiarLocal();
    }

    return { autoguardar, alCobrar, refrescar };
  }

  return { init };
})();
