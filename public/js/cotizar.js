/* Cotización: calculadora de metros cuadrados para techos PVC + productos sueltos. */
(function () {
  const $ = (s) => document.querySelector(s);
  const nf = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
  const nfCant = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });
  const pesos = (v) => '$ ' + nf.format(Math.round(Number(v) || 0));
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const A = window.APP;
  let items = [];
  let enviando = false;

  // Mismas fórmulas del programa original; la cantidad se redondea hacia arriba.
  const FORMULAS = {
    lamina: (m) => m / 1.79,
    cornisa: (m) => (1.2 * m) / 6,
    omega: (m) => (7 * m) / 10,
    vigueta: (m) => (5 * m) / 10,
    angulo: (m) => (8 * m) / 10,
    tornillo_lamina: (m) => 10 * m,
    tornillo_estructura: (m) => 10 * m,
  };

  function buscarProductoPorNombre(nombre) {
    const t = nombre.toLowerCase();
    return (
      A.productos.find((p) => p.nombre.toLowerCase() === t) ||
      A.productos.find((p) => p.nombre.toLowerCase().includes(t.split(' ')[0]))
    );
  }

  $('#btnCalcular').addEventListener('click', () => {
    const m = Number($('#cM2').value) || 0;
    if (m <= 0) {
      alert('Escribe cuántos metros cuadrados son.');
      return;
    }
    items = A.materialesM2.map((mat) => {
      const cantidad = Math.ceil(FORMULAS[mat.clave](m));
      const prod = buscarProductoPorNombre(mat.nombre);
      return {
        producto_id: prod ? prod.id : null,
        descripcion: mat.nombre,
        detalle: mat.texto,
        cantidad,
        precio: prod ? prod.precio : 0,
        stock: false,
        existencias: 0,
      };
    });
    pintar();
  });

  // ---------- Búsqueda de productos sueltos ----------
  const buscar = $('#buscar');
  const sugerencias = $('#sugerencias');
  let marcada = -1;

  function candidatos(texto) {
    const t = texto.trim().toLowerCase();
    if (!t) return [];
    return A.productos.filter((p) => p.nombre.toLowerCase().includes(t)).slice(0, 8);
  }

  function pintarSugerencias() {
    const lista = candidatos(buscar.value);
    if (lista.length === 0) {
      sugerencias.hidden = true;
      sugerencias.innerHTML = '';
      return;
    }
    sugerencias.innerHTML = lista
      .map(
        (p, idx) =>
          `<li data-id="${p.id}" class="${idx === marcada ? 'marcada' : ''}"><span>${esc(p.nombre)}</span><span class="sug-precio">${pesos(p.precio)}</span></li>`
      )
      .join('');
    sugerencias.hidden = false;
  }

  buscar.addEventListener('input', () => {
    marcada = -1;
    pintarSugerencias();
  });

  buscar.addEventListener('keydown', (e) => {
    const lista = candidatos(buscar.value);
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
      const p = lista[marcada >= 0 ? marcada : 0];
      if (p) {
        items.push({ producto_id: p.id, descripcion: p.nombre, cantidad: 1, precio: p.precio, stock: false, existencias: 0 });
        buscar.value = '';
        sugerencias.hidden = true;
        pintar();
      }
    }
  });

  sugerencias.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const p = A.productos.find((x) => x.id === Number(li.dataset.id));
    if (p) {
      items.push({ producto_id: p.id, descripcion: p.nombre, cantidad: 1, precio: p.precio, stock: false, existencias: 0 });
      buscar.value = '';
      sugerencias.hidden = true;
      pintar();
    }
  });

  // ---------- Totales y tabla ----------
  function totales() {
    const subtotal = items.reduce((a, i) => a + i.cantidad * i.precio, 0);
    const desc = Math.min(Math.max(Number($('#fDescuento').value) || 0, 0), subtotal);
    const base = subtotal - desc;
    const iva = $('#fIva').checked ? Math.round(base * 0.19) : 0;
    return { subtotal, descuento: desc, iva, total: base + iva };
  }

  function pintarItems() {
    $('#vacioFactura').hidden = items.length > 0;
    $('#itemsFactura').innerHTML = items
      .map(
        (i, idx) => `<tr>
        <td>${esc(i.descripcion)}${i.detalle ? ` <small>${esc(i.detalle)}</small>` : ''}</td>
        <td class="n"><input class="in n" type="number" min="0" step="0.01" value="${i.cantidad}" data-idx="${idx}" data-campo="cantidad"></td>
        <td class="n"><input class="in n" type="number" min="0" step="1" value="${i.precio}" data-idx="${idx}" data-campo="precio"></td>
        <td class="n">${pesos(i.cantidad * i.precio)}</td>
        <td class="n"><button class="quitar" type="button" data-quitar="${idx}">×</button></td>
      </tr>`
      )
      .join('');
  }

  document.addEventListener('input', (e) => {
    const campo = e.target.dataset && e.target.dataset.campo;
    if (!campo || e.target.dataset.idx === undefined) return;
    const idx = Number(e.target.dataset.idx);
    if (!items[idx]) return;
    items[idx][campo] = Number(e.target.value) || 0;
    const fila = e.target.closest('tr');
    if (fila && fila.children[3]) fila.children[3].textContent = pesos(items[idx].cantidad * items[idx].precio);
    pintarTotales();
    pintarPreview();
  });

  document.addEventListener('click', (e) => {
    const q = e.target.dataset && e.target.dataset.quitar;
    if (q === undefined) return;
    items.splice(Number(q), 1);
    pintar();
  });

  function pintarPreview() {
    const t = totales();
    const a = A.almacen;
    const ahora = new Date();
    const hora = ahora.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
    const fecha = ahora.toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });
    const m2 = Number($('#cM2').value) || 0;

    const filas =
      items
        .map(
          (i) => `<tr><td>${esc(i.descripcion)}</td><td class="c">${nfCant.format(i.cantidad)}</td>
          <td class="r">${pesos(i.precio)}</td><td class="r">${pesos(i.cantidad * i.precio)}</td></tr>`
        )
        .join('') || '<tr><td colspan="4">&nbsp;</td></tr>';

    $('#previewFactura').innerHTML = `<div class="tk">
      <div class="c">${esc(a.encabezado || a.nombre)}</div>
      <div class="c">${esc(a.direccion)}</div>
      <div class="c tk-tipo">COTIZACIÓN</div>
      <div class="c">NIT: ${esc(a.nit)}</div>
      <div class="c">Tel: ${esc(a.telefono)}</div>
      <div class="tk-f3"><span>Fecha/Hora:</span><span class="c">${hora}</span><span class="r">${fecha}</span></div>
      <div class="tk-cli"><span>CLIENTE</span><span class="r">${esc($('#fCliente').value || 'Cliente')}</span></div>
      ${m2 ? `<div class="tk-f2"><span>ÁREA</span><span>${nfCant.format(m2)} m²</span></div>` : ''}
      <table><thead><tr><th class="l">Material</th><th>cant</th><th>precio</th><th class="r">Total</th></tr></thead>
        <tbody>${filas}</tbody></table>
      <div class="tk-tot">
        <span>Subtotal</span><span>${pesos(t.subtotal)}</span>
        <span>IVA (19%)</span><span>${t.iva ? pesos(t.iva) : '—'}</span>
        <span>Descuento</span><span>${t.descuento ? pesos(t.descuento) : '—'}</span>
        <span class="tk-grande">Total</span><span class="tk-grande">${pesos(t.total)}</span>
      </div>
      <div class="c tk-pie">Cotización válida por 15 días</div>
      <div class="c">Le atendió: ${esc(A.vendedor)}</div>
      ${a.nota ? `<div class="c tk-nota">${esc(a.nota)}</div>` : ''}
    </div>`;
  }

  function pintarTotales() {
    $('#fTotal').textContent = pesos(totales().total);
  }

  function pintar() {
    pintarItems();
    pintarTotales();
    pintarPreview();
  }

  $('#btnCobrar').addEventListener('click', async () => {
    if (enviando) return;
    if (items.length === 0) {
      alert('La cotización no tiene materiales.');
      return;
    }
    enviando = true;
    $('#btnCobrar').disabled = true;
    try {
      const r = await fetch(A.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cliente: $('#fCliente').value,
          descuento: Number($('#fDescuento').value) || 0,
          iva: $('#fIva').checked,
          m2: Number($('#cM2').value) || null,
          items: items.map((i) => ({
            producto_id: i.producto_id,
            descripcion: i.descripcion,
            detalle: i.detalle || null,
            cantidad: i.cantidad,
            precio_unit: i.precio,
          })),
        }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'No se pudo guardar');
      window.location.href = data.imprimir;
    } catch (err) {
      alert('No se pudo guardar la cotización: ' + err.message);
      enviando = false;
      $('#btnCobrar').disabled = false;
    }
  });

  $('#btnNueva').addEventListener('click', () => {
    items = [];
    $('#cM2').value = '';
    $('#fCliente').value = '';
    $('#fDescuento').value = '';
    pintar();
  });

  ['#fDescuento', '#cM2'].forEach((sel) =>
    $(sel).addEventListener('input', () => {
      pintarTotales();
      pintarPreview();
    })
  );
  $('#fIva').addEventListener('change', () => {
    pintarTotales();
    pintarPreview();
  });
  $('#fCliente').addEventListener('input', pintarPreview);

  pintar();
})();
