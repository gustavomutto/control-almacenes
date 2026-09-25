/* Punto de venta: búsqueda de productos, líneas, pagos, totales y vista previa. */
(function () {
  const $ = (s) => document.querySelector(s);
  const nf = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
  const nfCant = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });
  const pesos = (v) => '$ ' + nf.format(Math.round(Number(v) || 0));
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const A = window.APP;
  let items = [];
  let pagos = [{ metodo: A.metodos[0] || 'Efectivo', valor: null }];
  let enviando = false;

  // Ventas en espera (se conecta más abajo; así `pintar()` ya puede llamarlo sin romperse).
  let espera = { autoguardar() {}, alCobrar() {} };
  const IVA_DEFECTO = document.querySelector('#fIva').checked;

  // ---------- Totales ----------
  function totales() {
    const subtotal = items.reduce((a, i) => a + i.cantidad * i.precio, 0);
    const desc = Math.min(Math.max(Number($('#fDescuento').value) || 0, 0), subtotal);
    const base = subtotal - desc;
    const iva = $('#fIva').checked ? Math.round(base * 0.19) : 0;
    return { subtotal, descuento: desc, iva, total: base + iva };
  }

  // ---------- Búsqueda ----------
  const buscar = $('#buscar');
  const sugerencias = $('#sugerencias');
  let marcada = -1;

  function candidatos(texto) {
    const t = texto.trim().toLowerCase();
    if (!t) return [];
    return A.productos.filter((p) => p.nombre.toLowerCase().includes(t)).slice(0, 8);
  }

  function pintarSugerencias() {
    const { termino } = partirCantidad(buscar.value);
    const lista = candidatos(termino);
    if (lista.length === 0) {
      sugerencias.hidden = true;
      sugerencias.innerHTML = '';
      marcada = -1;
      return;
    }
    sugerencias.innerHTML = lista
      .map(
        (p, idx) =>
          `<li data-id="${p.id}" class="${idx === marcada ? 'marcada' : ''}">
             <span>${esc(p.nombre)}</span>
             <span class="sug-precio">${pesos(p.precio)}${p.stock ? ' · ' + nfCant.format(p.existencias) + ' ' + esc(p.unidad) : ''}</span>
           </li>`
      )
      .join('');
    sugerencias.hidden = false;
  }

  // "3*lamina" => cantidad 3, término "lamina"
  function partirCantidad(texto) {
    const m = String(texto).match(/^\s*(\d+(?:[.,]\d+)?)\s*\*\s*(.*)$/);
    if (m) return { cantidad: Number(m[1].replace(',', '.')), termino: m[2] };
    return { cantidad: 1, termino: texto };
  }

  function agregarProducto(producto, cantidad) {
    const existente = items.find((i) => i.producto_id === producto.id);
    if (existente) existente.cantidad += cantidad;
    else
      items.push({
        producto_id: producto.id,
        descripcion: producto.nombre,
        cantidad,
        precio: producto.precio,
        unidad: producto.unidad,
        existencias: producto.existencias,
        stock: producto.stock,
      });
    buscar.value = '';
    sugerencias.hidden = true;
    marcada = -1;
    pintar();
  }

  buscar.addEventListener('input', () => {
    marcada = -1;
    pintarSugerencias();
  });

  buscar.addEventListener('keydown', (e) => {
    const lista = candidatos(partirCantidad(buscar.value).termino);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      marcada = Math.min(marcada + 1, lista.length - 1);
      pintarSugerencias();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      marcada = Math.max(marcada - 1, 0);
      pintarSugerencias();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const { cantidad } = partirCantidad(buscar.value);
      const elegido = lista[marcada >= 0 ? marcada : 0];
      if (elegido) agregarProducto(elegido, cantidad);
    } else if (e.key === 'Escape') {
      sugerencias.hidden = true;
    }
  });

  sugerencias.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const p = A.productos.find((x) => x.id === Number(li.dataset.id));
    if (p) agregarProducto(p, partirCantidad(buscar.value).cantidad);
  });

  // ---------- Tabla de líneas ----------
  function pintarItems() {
    const cuerpo = $('#itemsFactura');
    $('#vacioFactura').hidden = items.length > 0;
    cuerpo.innerHTML = items
      .map((i, idx) => {
        const falta = i.stock && i.cantidad > i.existencias;
        return `<tr${falta ? ' class="sin-stock"' : ''}>
          <td>${esc(i.descripcion)}${falta ? ` <small>(solo hay ${nfCant.format(i.existencias)})</small>` : ''}</td>
          <td class="n"><input class="in n" type="number" min="0" step="0.01" value="${i.cantidad}" data-idx="${idx}" data-campo="cantidad"></td>
          <td class="n"><input class="in n" type="number" min="0" step="1" value="${i.precio}" data-idx="${idx}" data-campo="precio"></td>
          <td class="n">${pesos(i.cantidad * i.precio)}</td>
          <td class="n"><button class="quitar" type="button" data-quitar="${idx}" title="Quitar">×</button></td>
        </tr>`;
      })
      .join('');
  }

  document.addEventListener('input', (e) => {
    const campo = e.target.dataset && e.target.dataset.campo;
    if (!campo || e.target.dataset.idx === undefined) return;
    const idx = Number(e.target.dataset.idx);
    if (!items[idx]) return;
    items[idx][campo] = Number(e.target.value) || 0;
    // Actualizamos solo la celda del total de esa fila, para no perder el cursor
    // que el usuario está usando en el campo.
    const fila = e.target.closest('tr');
    if (fila) {
      const celdaTotal = fila.children[3];
      if (celdaTotal) celdaTotal.textContent = pesos(items[idx].cantidad * items[idx].precio);
    }
    pintarTotales();
    pintarPreview();
  });

  document.addEventListener('click', (e) => {
    const q = e.target.dataset && e.target.dataset.quitar;
    if (q === undefined) return;
    items.splice(Number(q), 1);
    pintar();
  });

  // ---------- Pagos ----------
  function pintarPagos() {
    const t = totales().total;
    $('#listaPagos').innerHTML = pagos
      .map(
        (p, idx) => `<div class="pago">
        <select data-pago="${idx}" data-campo="metodo">
          ${A.metodos.map((m) => `<option ${m === p.metodo ? 'selected' : ''}>${esc(m)}</option>`).join('')}
        </select>
        <input class="in n" type="number" min="0" step="1" data-pago="${idx}" data-campo="valor"
               placeholder="${idx === 0 ? nf.format(Math.round(t)) : '0'}" value="${p.valor === null ? '' : p.valor}">
        ${pagos.length > 1 ? `<button class="quitar" type="button" data-quitar-pago="${idx}">×</button>` : '<span></span>'}
      </div>`
      )
      .join('');

    const pagado = pagos.reduce((a, p) => a + (p.valor === null ? (pagos.length === 1 ? t : 0) : p.valor), 0);
    const estado = $('#pagosEstado');
    const dif = Math.round(pagado - t);
    if (items.length === 0) {
      estado.textContent = '';
      estado.dataset.t = '';
    } else if (dif < 0) {
      estado.textContent = 'Falta ' + pesos(-dif);
      estado.dataset.t = 'falta';
    } else if (dif > 0) {
      estado.textContent = 'Cambio ' + pesos(dif);
      estado.dataset.t = 'cambio';
    } else {
      estado.textContent = 'Pago exacto';
      estado.dataset.t = 'ok';
    }
  }

  document.addEventListener('input', (e) => {
    const idx = e.target.dataset && e.target.dataset.pago;
    if (idx === undefined) return;
    const campo = e.target.dataset.campo;
    pagos[Number(idx)][campo] = campo === 'valor' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value;
    pintarPagos();
    pintarPreview();
  });

  document.addEventListener('change', (e) => {
    const idx = e.target.dataset && e.target.dataset.pago;
    if (idx === undefined || e.target.dataset.campo !== 'metodo') return;
    pagos[Number(idx)].metodo = e.target.value;
    pintarPreview();
  });

  document.addEventListener('click', (e) => {
    const q = e.target.dataset && e.target.dataset.quitarPago;
    if (q === undefined) return;
    pagos.splice(Number(q), 1);
    pintarPagos();
    pintarPreview();
  });

  $('#btnAgregarPago').addEventListener('click', () => {
    pagos.push({ metodo: A.metodos[1] || A.metodos[0] || 'Efectivo', valor: null });
    pintarPagos();
  });

  // ---------- Vista previa del ticket ----------
  function pintarPreview() {
    const t = totales();
    const a = A.almacen;
    const ahora = new Date();
    const hora = ahora.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
    const fecha = ahora.toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });
    const pagado = pagos.reduce((a2, p) => a2 + (p.valor === null ? (pagos.length === 1 ? t.total : 0) : p.valor), 0);
    const cambio = Math.max(0, Math.round(pagado - t.total));

    const filas =
      items
        .map(
          (i) => `<tr><td>${esc(i.descripcion)}</td><td class="c">${nfCant.format(i.cantidad)}</td>
        <td class="r">${pesos(i.precio)}</td><td class="r">${pesos(i.cantidad * i.precio)}</td></tr>`
        )
        .join('') || '<tr><td colspan="4">&nbsp;</td></tr>';

    let bloquePagos = '';
    if (items.length) {
      if (pagos.length === 1 && !cambio) {
        bloquePagos = `<span>Método de pago</span><span>${esc(pagos[0].metodo)}</span>`;
      } else {
        bloquePagos =
          '<span class="tk-sep"></span><span>Método de pago</span><span></span>' +
          pagos
            .map(
              (p) =>
                `<span>${esc(p.metodo)}</span><span>${pesos(p.valor === null && pagos.length === 1 ? t.total : p.valor || 0)}</span>`
            )
            .join('') +
          (cambio ? `<span>Cambio</span><span>${pesos(cambio)}</span>` : '');
      }
    }

    // En hoja carta la vista previa es la factura normal, no la tirilla.
    if (a.papel === 'carta') {
      $('#previewFactura').innerHTML = previewCarta(t, a, hora, fecha, cambio);
      return;
    }

    $('#previewFactura').innerHTML = `<div class="tk">
      <div class="c">${esc(a.encabezado || a.nombre)}</div>
      <div class="c">${esc(a.direccion)}</div>
      <div class="c tk-tipo">${A.tipo === 'factura' ? 'FACTURA DE VENTA' : 'COTIZACIÓN'}</div>
      <div class="c">NIT: ${esc(a.nit)}</div>
      <div class="c">Tel: ${esc(a.telefono)}</div>
      <div class="tk-f3"><span>Fecha/Hora:</span><span class="c">${hora}</span><span class="r">${fecha}</span></div>
      <div class="tk-f3"><span>${A.tipo === 'factura' ? 'Factura Nº:' : 'Cotización Nº:'}</span><span class="c">${A.numero}</span><span></span></div>
      <div class="tk-cli"><span>CLIENTE</span><span class="r">${esc($('#fCliente').value || 'Consumidor final')}</span></div>
      <table><thead><tr><th class="l">Producto</th><th>cant</th><th>precio</th><th class="r">Total</th></tr></thead>
        <tbody>${filas}</tbody></table>
      <div class="tk-tot">
        <span>Subtotal</span><span>${pesos(t.subtotal)}</span>
        <span>IVA (19%)</span><span>${t.iva ? pesos(t.iva) : '—'}</span>
        <span>Descuento</span><span>${t.descuento ? pesos(t.descuento) : '—'}</span>
        <span class="tk-grande">Total a Pagar</span><span class="tk-grande">${pesos(t.total)}</span>
        ${bloquePagos}
      </div>
      <div class="c tk-pie">¡Gracias por su compra!</div>
      <div class="c">Le atendió: ${esc(A.vendedor)}</div>
      ${a.nota ? `<div class="c tk-nota">${esc(a.nota)}</div>` : ''}
    </div>`;
  }

  // Vista previa de la factura en hoja carta (la misma que sale impresa).
  function previewCarta(t, a, hora, fecha, cambio) {
    const esFactura = A.tipo === 'factura';
    const conValor = pagos.map((p) => ({
      metodo: p.metodo,
      valor: p.valor === null ? (pagos.length === 1 ? t.total : 0) : p.valor,
    }));
    const pagados = conValor.filter((p) => Number(p.valor) > 0);
    const forma = pagados.length === 0 ? 'Sin registrar' : pagados.length === 1 ? pagados[0].metodo : 'Mixto';

    const filas =
      items
        .map(
          (i) => `<tr><td>${esc(i.descripcion)}</td><td>${nfCant.format(i.cantidad)}</td>
            <td>${pesos(i.precio)}</td><td>${pesos(i.cantidad * i.precio)}</td></tr>`
        )
        .join('') || '<tr><td colspan="4">&nbsp;</td></tr>';

    const detallePago =
      pagados.length > 1 || cambio
        ? `<div class="fx-detalle">
             ${pagados.map((p) => `<span>${esc(p.metodo)}</span><span>${pesos(p.valor)}</span>`).join('')}
             ${cambio ? `<span>Cambio</span><span>${pesos(cambio)}</span>` : ''}
           </div>`
        : '';

    return `<div class="fx">
      <div class="fx-cab">
        <div class="fx-negocio">
          <strong>${esc(a.encabezado || a.nombre)}</strong>
          ${a.direccion ? `<div>${esc(a.direccion)}</div>` : ''}
          <div>${a.telefono ? 'Tel: ' + esc(a.telefono) : ''}${a.telefono && a.nit ? ' · ' : ''}${a.nit ? 'NIT: ' + esc(a.nit) : ''}</div>
        </div>
        <div class="fx-doc">
          <div class="fx-tipo">${esFactura ? 'Factura de venta' : 'Cotización'}</div>
          <div class="fx-num">N° ${A.numero}</div>
          <div>${fecha}</div>
          <div>${hora}</div>
        </div>
      </div>
      <div class="fx-cliente">
        <div><span>Cliente:</span><b>${esc($('#fCliente').value || 'Consumidor final')}</b></div>
        <div><span>Atendió:</span><b>${esc(A.vendedor)}</b></div>
      </div>
      <table>
        <thead><tr><th>Producto</th><th style="width:12%">Cantidad</th><th style="width:18%">V. unitario</th><th style="width:18%">V. total</th></tr></thead>
        <tbody>${filas}</tbody>
      </table>
      <div class="fx-resumen">
        <div class="fx-pago">
          <div class="fx-rotulo">${esFactura ? 'Forma de pago' : 'Validez'}</div>
          <b>${esFactura ? esc(forma) : '15 días'}</b>
          ${esFactura ? detallePago : ''}
        </div>
        <div class="fx-totales">
          <span>Subtotal</span><span>${pesos(t.subtotal)}</span>
          ${t.descuento ? `<span>Descuento</span><span>- ${pesos(t.descuento)}</span>` : ''}
          ${t.iva ? `<span>IVA 19%</span><span>${pesos(t.iva)}</span>` : ''}
          <i></i><span class="fx-total">${esFactura ? 'Total a pagar' : 'Total cotizado'}</span>
          <span class="fx-total">${pesos(t.total)}</span>
        </div>
      </div>
      ${a.nota ? `<div class="fx-nota">${esc(a.nota)}</div>` : ''}
      <div class="fx-cierre">
        <div class="fx-firma">${esFactura ? 'Firma y sello' : 'Elaborado por'}</div>
        <p class="fx-mensaje">${
          esFactura
            ? '¡Gracias por su compra!<br>Conserve esta factura como comprobante para cualquier cambio o garantía.'
            : 'Cotización válida por 15 días.<br>Los precios pueden variar según la disponibilidad del material.'
        }</p>
      </div>
    </div>`;
  }

  function pintarTotales() {
    $('#fTotal').textContent = pesos(totales().total);
    pintarPagos();
  }

  function pintar() {
    pintarItems();
    pintarTotales();
    pintarPreview();
    espera.autoguardar();
  }

  // ---------- Lo que se guarda y se retoma ----------
  function estadoActual() {
    const t = totales();
    return {
      lineas: items.length,
      total: t.total,
      nombre: $('#fCliente').value.trim(),
      datos: {
        items,
        pagos,
        cliente: $('#fCliente').value,
        descuento: $('#fDescuento').value,
        iva: $('#fIva').checked,
      },
    };
  }

  function cargarEstado(d) {
    if (!d) return;
    items = Array.isArray(d.items) ? d.items : [];
    pagos = Array.isArray(d.pagos) && d.pagos.length ? d.pagos : [{ metodo: A.metodos[0] || 'Efectivo', valor: null }];
    $('#fCliente').value = d.cliente || '';
    $('#fDescuento').value = d.descuento || '';
    $('#fIva').checked = Boolean(d.iva);
    pintar();
  }

  function limpiarVenta() {
    items = [];
    pagos = [{ metodo: A.metodos[0] || 'Efectivo', valor: null }];
    $('#fCliente').value = '';
    $('#fDescuento').value = '';
    $('#fIva').checked = IVA_DEFECTO;
    pintar();
  }

  // ---------- Guardar ----------
  $('#btnCobrar').addEventListener('click', async () => {
    if (enviando) return;
    if (items.length === 0) {
      alert('Agrega al menos un producto a la venta.');
      return;
    }
    const sinStock = items.filter((i) => i.stock && i.cantidad > i.existencias);
    if (sinStock.length > 0) {
      const seguir = confirm(
        'No hay suficiente inventario de: ' +
          sinStock.map((i) => i.descripcion).join(', ') +
          '.\n\n¿Facturar de todos modos? (el inventario quedará en negativo)'
      );
      if (!seguir) return;
    }

    const t = totales();
    const cuerpo = {
      cliente: $('#fCliente').value,
      descuento: Number($('#fDescuento').value) || 0,
      iva: $('#fIva').checked,
      items: items.map((i) => ({
        producto_id: i.producto_id,
        descripcion: i.descripcion,
        cantidad: i.cantidad,
        precio_unit: i.precio,
      })),
      pagos: pagos.map((p, idx) => ({
        metodo: p.metodo,
        valor: p.valor === null ? (pagos.length === 1 ? t.total : 0) : p.valor,
      })),
    };

    enviando = true;
    $('#btnCobrar').disabled = true;
    try {
      const r = await fetch(A.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cuerpo),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'No se pudo guardar');
      espera.alCobrar(); // ya es una factura: el borrador local se descarta
      window.location.href = data.imprimir;
    } catch (err) {
      alert('No se pudo guardar la venta: ' + err.message);
      enviando = false;
      $('#btnCobrar').disabled = false;
    }
  });

  $('#btnNueva').addEventListener('click', () => {
    if (items.length > 0 && !confirm('¿Vaciar esta venta? Si el cliente va a volver, mejor déjala en espera.')) return;
    limpiarVenta();
    buscar.focus();
  });

  const btnRe = $('#btnReimprimir');
  if (btnRe && btnRe.dataset.id) {
    btnRe.addEventListener('click', () => {
      window.location.href = '/almacen/imprimir/' + btnRe.dataset.id + '?auto=0';
    });
  }

  $('#fDescuento').addEventListener('input', () => {
    pintarTotales();
    pintarPreview();
  });
  $('#fIva').addEventListener('change', () => {
    pintarTotales();
    pintarPreview();
  });
  $('#fCliente').addEventListener('input', pintarPreview);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F9') {
      e.preventDefault();
      $('#btnCobrar').click();
    }
    if (e.key === 'F4') {
      e.preventDefault();
      $('#btnNueva').click();
    }
    // F2: deja la venta actual en espera y abre una factura nueva.
    if (e.key === 'F2') {
      e.preventDefault();
      if (espera.nueva) espera.nueva();
    }
  });

  $('#fCliente').addEventListener('input', () => espera.autoguardar());

  if (window.Espera) {
    espera = window.Espera.init({
      tipo: 'factura',
      contenedor: '#espera',
      almacenId: A.almacenId,
      estado: estadoActual,
      cargar: cargarEstado,
      limpiar: limpiarVenta,
      foco: () => buscar.focus(),
    });
  }

  pintar();
  buscar.focus();
})();
