/* Catálogo de productos sin recargar la página.
   La misma pantalla sirve para el almacén (con precio de venta) y para la bodega (sin precio).
   Todo pasa por detrás: agregar, editar, entradas, quitar y devolver. */
(function () {
  const C = window.CATALOGO;
  if (!C) return;

  const $ = (s) => document.querySelector(s);
  const nf = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
  const nfCant = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });
  const fmt = (v) => '$ ' + nf.format(Number(v) || 0);
  const esc = (s) =>
    String(s == null ? '' : s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
    );

  const tabla = $('#tablaCatalogo');
  if (!tabla) return;
  const cuerpo = tabla.querySelector('tbody');
  const buscador = $('#buscarProducto');
  const verQuitados = $('#verQuitados');
  const conteo = $('#conteoCatalogo');
  const aviso = $('#avisoCatalogo');
  const formNuevo = $('#formProducto');

  let items = (C.productos || []).map((p) => ({ ...p }));
  let editando = null;
  let ocupado = false;

  // ---------- búsqueda ----------
  // Sin tildes y por palabras: "tub 1/2" encuentra "Tubo PVC 1/2".
  const plano = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();

  function visibles() {
    const partes = plano(buscador ? buscador.value : '').split(/\s+/).filter(Boolean);
    return items.filter((p) => {
      if (!p.activo && !(verQuitados && verQuitados.checked)) return false;
      if (partes.length === 0) return true;
      const texto = plano(p.nombre + ' ' + p.unidad);
      return partes.every((t) => texto.indexOf(t) !== -1);
    });
  }

  // ---------- dibujo ----------
  function celdaEntrada(p) {
    if (!p.activo) return '<td class="n">—</td>';
    if (!p.controla_stock) return '<td class="n">—</td>';
    return (
      '<td class="n"><div class="fila-entrada">' +
      '<input class="in n" style="width:90px" type="number" step="0.01" placeholder="+ cant." data-campo="cantidad">' +
      '<button class="btn linea mini" type="button" data-accion="entrada">Entró</button>' +
      '</div></td>'
    );
  }

  function filaNormal(p) {
    const sinStock = p.controla_stock && Number(p.existencias) <= 0;
    const clases = [p.activo ? '' : 'quitado', sinStock && p.activo ? 'sin-stock' : ''].filter(Boolean).join(' ');
    let html = '<tr data-id="' + p.id + '"' + (clases ? ' class="' + clases + '"' : '') + '>';
    html += '<td>' + esc(p.nombre) + (p.activo ? '' : ' <small class="etiqueta">quitado</small>') + '</td>';
    html += '<td>' + esc(p.unidad) + '</td>';
    if (C.conPrecio) html += '<td class="n">' + fmt(p.precio_venta) + '</td>';
    html += '<td class="n">' + (p.controla_stock ? nfCant.format(p.existencias) : '—') + '</td>';
    html += celdaEntrada(p);
    html += '<td class="n acciones">';
    if (p.activo) {
      html += '<button class="btn linea mini" type="button" data-accion="editar">Editar</button> ';
      html += '<button class="btn peligro mini" type="button" data-accion="quitar">Quitar</button>';
    } else {
      html += '<button class="btn linea mini" type="button" data-accion="devolver">Devolver</button>';
    }
    html += '</td></tr>';
    return html;
  }

  function filaEditando(p) {
    let html = '<tr data-id="' + p.id + '" class="editando">';
    html +=
      '<td><input class="in" style="width:100%" type="text" data-campo="nombre" value="' + esc(p.nombre) + '"></td>';
    html +=
      '<td><input class="in" style="width:90px" type="text" data-campo="unidad" value="' + esc(p.unidad) + '"></td>';
    if (C.conPrecio) {
      html +=
        '<td class="n"><input class="in n" style="width:110px" type="number" min="0" step="1" data-campo="precio" value="' +
        Number(p.precio_venta) +
        '"></td>';
    }
    html += '<td class="n">' + (p.controla_stock ? nfCant.format(p.existencias) : '—') + '</td>';
    html +=
      '<td class="n"><label class="check" style="justify-content:flex-end"><input type="checkbox" data-campo="stock"' +
      (p.controla_stock ? ' checked' : '') +
      '> Descuenta</label></td>';
    html +=
      '<td class="n acciones">' +
      '<button class="btn prim mini" type="button" data-accion="guardar">Guardar</button> ' +
      '<button class="btn linea mini" type="button" data-accion="cancelar">Cancelar</button>' +
      '</td></tr>';
    return html;
  }

  const fila = (p) => (editando === p.id ? filaEditando(p) : filaNormal(p));
  const columnas = C.conPrecio ? 6 : 5;

  function pintar() {
    const lista = visibles();
    cuerpo.innerHTML =
      lista.length === 0
        ? '<tr><td colspan="' + columnas + '" class="vacio">' + esc(textoVacio()) + '</td></tr>'
        : lista.map(fila).join('');
    if (conteo) {
      const activos = items.filter((p) => p.activo).length;
      const quitados = items.length - activos;
      conteo.textContent =
        activos + ' producto' + (activos === 1 ? '' : 's') + (quitados ? ' (+' + quitados + ' quitado(s))' : '');
    }
  }

  function textoVacio() {
    if (buscador && buscador.value.trim()) return 'Ningún producto coincide con «' + buscador.value.trim() + '».';
    return C.vacio || 'Todavía no hay productos.';
  }

  function repintarFila(id) {
    const p = items.find((x) => x.id === id);
    const tr = cuerpo.querySelector('tr[data-id="' + id + '"]');
    if (!p || !tr) return pintar();
    // Si el producto ya no debe verse (lo quitaron y no se están mostrando los quitados)
    // o dejó de coincidir con la búsqueda, se redibuja toda la tabla.
    if (visibles().indexOf(p) === -1) return pintar();
    tr.outerHTML = fila(p);
    const nueva = cuerpo.querySelector('tr[data-id="' + id + '"]');
    if (nueva) {
      nueva.classList.add('resaltado');
      setTimeout(() => nueva.classList.remove('resaltado'), 1200);
    }
  }

  function guardarEnLista(producto) {
    const i = items.findIndex((x) => x.id === producto.id);
    if (i === -1) {
      items.push(producto);
      items.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    } else {
      items[i] = producto;
    }
  }

  // ---------- avisos ----------
  let borrarAviso = null;
  function avisar(texto, tipo) {
    if (!aviso) return;
    aviso.textContent = texto;
    aviso.className = 'mensaje ' + (tipo === 'error' ? 'error' : 'ok');
    aviso.hidden = false;
    clearTimeout(borrarAviso);
    if (tipo !== 'error') borrarAviso = setTimeout(() => (aviso.hidden = true), 4000);
  }

  // ---------- servidor ----------
  async function pedir(url, datos) {
    ocupado = true;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify(datos || {}),
      });
      const cuerpoR = await r.json().catch(() => ({ ok: false, error: 'El servidor no contestó bien.' }));
      if (!r.ok || !cuerpoR.ok) throw new Error(cuerpoR.error || 'No se pudo guardar.');
      return cuerpoR;
    } finally {
      ocupado = false;
    }
  }

  // ---------- acciones ----------
  cuerpo.addEventListener('click', async (e) => {
    const boton = e.target.closest('button[data-accion]');
    if (!boton || ocupado) return;
    const tr = boton.closest('tr[data-id]');
    const id = Number(tr.dataset.id);
    const accion = boton.dataset.accion;

    if (accion === 'editar') {
      editando = id;
      pintar();
      const campo = cuerpo.querySelector('tr[data-id="' + id + '"] [data-campo="nombre"]');
      if (campo) campo.focus();
      return;
    }
    if (accion === 'cancelar') {
      editando = null;
      pintar();
      return;
    }
    if (accion === 'guardar') return void (await guardarEdicion(id, tr, boton));
    if (accion === 'entrada') return void (await registrarEntrada(id, tr, boton));
    if (accion === 'quitar') {
      const p = items.find((x) => x.id === id);
      const nombre = p ? p.nombre : 'este producto';
      if (!confirm('¿Quitar «' + nombre + '»?\n\nNo se borra nada: sale del catálogo y las facturas que ya lo tienen quedan igual. Lo puedes devolver cuando quieras.')) return;
      return void (await cambiarEstado(id, 'eliminar', boton));
    }
    if (accion === 'devolver') return void (await cambiarEstado(id, 'activar', boton));
  });

  async function guardarEdicion(id, tr, boton) {
    const datos = {
      nombre: tr.querySelector('[data-campo="nombre"]').value,
      unidad: tr.querySelector('[data-campo="unidad"]').value,
      controla_stock: tr.querySelector('[data-campo="stock"]').checked,
    };
    if (C.conPrecio) datos.precio_venta = tr.querySelector('[data-campo="precio"]').value;
    boton.disabled = true;
    try {
      const r = await pedir(C.base + '/' + id + '/editar', datos);
      guardarEnLista(r.producto);
      editando = null;
      pintar();
      avisar(r.mensaje, 'ok');
    } catch (err) {
      boton.disabled = false;
      avisar(err.message, 'error');
    }
  }

  async function registrarEntrada(id, tr, boton) {
    const campo = tr.querySelector('[data-campo="cantidad"]');
    const cantidad = Number(campo.value);
    if (!cantidad) {
      avisar('Escribe cuánto entró.', 'error');
      campo.focus();
      return;
    }
    boton.disabled = true;
    try {
      const r = await pedir(C.base + '/' + id + '/entrada', { cantidad });
      guardarEnLista(r.producto);
      repintarFila(id);
      avisar(r.mensaje, 'ok');
    } catch (err) {
      boton.disabled = false;
      avisar(err.message, 'error');
    }
  }

  async function cambiarEstado(id, accion, boton) {
    boton.disabled = true;
    try {
      const r = await pedir(C.base + '/' + id + '/' + accion, {});
      guardarEnLista(r.producto);
      pintar();
      avisar(r.mensaje, 'ok');
    } catch (err) {
      boton.disabled = false;
      avisar(err.message, 'error');
    }
  }

  // Enter dentro de la fila: guarda la edición o la entrada. Escape cancela la edición.
  cuerpo.addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const boton = tr.querySelector('[data-accion="guardar"]') || tr.querySelector('[data-accion="entrada"]');
      if (boton) boton.click();
    } else if (e.key === 'Escape' && editando === Number(tr.dataset.id)) {
      editando = null;
      pintar();
    }
  });

  // ---------- producto nuevo ----------
  if (formNuevo) {
    formNuevo.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (ocupado) return;
      const boton = formNuevo.querySelector('button[type="submit"]');
      const datos = {
        nombre: formNuevo.nombre.value,
        unidad: formNuevo.unidad.value,
        existencias: formNuevo.existencias.value,
        controla_stock: formNuevo.controla_stock.checked,
      };
      if (C.conPrecio && formNuevo.precio_venta) datos.precio_venta = formNuevo.precio_venta.value;
      boton.disabled = true;
      try {
        const r = await pedir(C.base, datos);
        guardarEnLista(r.producto);
        if (buscador) buscador.value = '';
        pintar();
        repintarFila(r.producto.id);
        avisar(r.mensaje, 'ok');
        formNuevo.reset();
        formNuevo.nombre.focus();
      } catch (err) {
        avisar(err.message, 'error');
      } finally {
        boton.disabled = false;
      }
    });
  }

  // ---------- filtros ----------
  if (buscador) {
    buscador.addEventListener('input', pintar);
    buscador.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        buscador.value = '';
        pintar();
      }
    });
  }
  if (verQuitados) verQuitados.addEventListener('change', pintar);

  pintar();
})();
