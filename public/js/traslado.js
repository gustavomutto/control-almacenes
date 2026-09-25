/* Hoja de traslado: buscar productos del almacén que envía y anotar cantidades.
   Sin precios: un traslado no es una venta. */
(function () {
  const $ = (s) => document.querySelector(s);
  const nfCant = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const A = window.APP;
  let items = [];
  let enviando = false;

  const buscar = $('#buscar');
  const sugerencias = $('#sugerencias');
  let marcada = -1;

  // "10*lamina" => cantidad 10, término "lamina"
  function partirCantidad(texto) {
    const m = String(texto).match(/^\s*(\d+(?:[.,]\d+)?)\s*\*\s*(.*)$/);
    if (m) return { cantidad: Number(m[1].replace(',', '.')), termino: m[2] };
    return { cantidad: 1, termino: texto };
  }

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
             <span class="sug-precio">${p.stock ? nfCant.format(p.existencias) + ' ' + esc(p.unidad) : 'sin control de stock'}</span>
           </li>`
      )
      .join('');
    sugerencias.hidden = false;
  }

  function agregar(producto, cantidad) {
    const ya = items.find((i) => i.producto_id === producto.id);
    if (ya) ya.cantidad += cantidad;
    else
      items.push({
        producto_id: producto.id,
        descripcion: producto.nombre,
        unidad: producto.unidad,
        existencias: producto.existencias,
        stock: producto.stock,
        cantidad,
      });
    buscar.value = '';
    sugerencias.hidden = true;
    marcada = -1;
    pintar();
  }

  function pintar() {
    const cuerpo = $('#itemsTraslado');
    cuerpo.innerHTML = items
      .map(
        (i, idx) => `
        <tr>
          <td>${esc(i.descripcion)}</td>
          <td class="n">${i.stock ? nfCant.format(i.existencias) + ' ' + esc(i.unidad) : '—'}</td>
          <td class="n">
            <input class="in n" style="width:110px" type="number" min="0.01" step="0.01"
                   data-idx="${idx}" value="${i.cantidad}">
          </td>
          <td class="n"><button class="btn peligro mini" type="button" data-quitar="${idx}">Quitar</button></td>
        </tr>`
      )
      .join('');
    $('#vacioTraslado').hidden = items.length > 0;
    $('#tUnidades').textContent = nfCant.format(items.reduce((a, i) => a + (Number(i.cantidad) || 0), 0));
    avisar();
  }

  // Aviso amable cuando se manda más de lo que hay: el servidor igual lo rechaza.
  function avisar() {
    const faltantes = items.filter((i) => i.stock && Number(i.cantidad) > Number(i.existencias));
    const aviso = $('#tAviso');
    if (faltantes.length === 0) {
      aviso.textContent = '';
      aviso.className = 'ayuda';
      return;
    }
    aviso.className = 'ayuda alerta';
    aviso.textContent =
      'Estás enviando más de lo que hay en inventario de: ' + faltantes.map((f) => f.descripcion).join(', ') + '.';
  }

  buscar.addEventListener('input', pintarSugerencias);
  buscar.addEventListener('keydown', (e) => {
    const lista = sugerencias.querySelectorAll('li');
    if (e.key === 'ArrowDown' && lista.length) {
      marcada = Math.min(marcada + 1, lista.length - 1);
      pintarSugerencias();
      e.preventDefault();
    } else if (e.key === 'ArrowUp' && lista.length) {
      marcada = Math.max(marcada - 1, 0);
      pintarSugerencias();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const { cantidad, termino } = partirCantidad(buscar.value);
      const lista2 = candidatos(termino);
      const elegido = marcada >= 0 ? lista2[marcada] : lista2[0];
      if (elegido) agregar(elegido, cantidad);
    } else if (e.key === 'Escape') {
      sugerencias.hidden = true;
      marcada = -1;
    }
  });

  sugerencias.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const producto = A.productos.find((p) => String(p.id) === li.dataset.id);
    const { cantidad } = partirCantidad(buscar.value);
    if (producto) agregar(producto, cantidad);
  });

  $('#itemsTraslado').addEventListener('input', (e) => {
    const idx = e.target.dataset.idx;
    if (idx === undefined) return;
    items[Number(idx)].cantidad = Number(e.target.value) || 0;
    $('#tUnidades').textContent = nfCant.format(items.reduce((a, i) => a + (Number(i.cantidad) || 0), 0));
    avisar();
  });

  $('#itemsTraslado').addEventListener('click', (e) => {
    const idx = e.target.dataset.quitar;
    if (idx === undefined) return;
    items.splice(Number(idx), 1);
    pintar();
  });

  $('#btnLimpiar').addEventListener('click', () => {
    items = [];
    pintar();
  });

  $('#btnGuardar').addEventListener('click', async () => {
    if (enviando) return;
    const destino = $('#tDestino').value;
    if (!destino) return alert('Elige el almacén que recibe la mercancía.');
    if (items.length === 0) return alert('Agrega al menos un producto a la hoja.');
    if (items.some((i) => !(Number(i.cantidad) > 0))) return alert('Hay cantidades en cero.');

    const origen = A.origenFijo || ($('#tOrigen') && $('#tOrigen').value);
    if (!origen) return alert('Elige el almacén que envía la mercancía.');

    enviando = true;
    $('#btnGuardar').disabled = true;
    try {
      const r = await fetch(A.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origen_id: origen,
          destino_id: destino,
          fecha: $('#tFecha').value,
          responsable: $('#tResponsable').value,
          nota: $('#tNota').value,
          items: items.map((i) => ({ producto_id: i.producto_id, cantidad: Number(i.cantidad) })),
        }),
      });
      const datos = await r.json();
      if (!datos.ok) throw new Error(datos.error || 'No se pudo guardar el traslado.');
      window.location.href = datos.imprimir;
    } catch (err) {
      alert(err.message);
      enviando = false;
      $('#btnGuardar').disabled = false;
    }
  });

  pintar();
})();
