/* Contar el dinero de la caja: suma mientras se escribe y guarda sin recargar. */
(function () {
  const A = window.ARQUEO;
  if (!A) return;

  const $ = (s) => document.querySelector(s);
  const nf = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
  const fmt = (v) => '$ ' + nf.format(Math.round(Number(v) || 0));

  const campos = [...document.querySelectorAll('[data-denominacion]')];
  const base = $('#arqueoBase');
  const nota = $('#arqueoNota');
  const aviso = $('#avisoArqueo');
  const veredicto = $('#arqueoVeredicto');
  const guardado = $('#arqueoGuardado');
  if (campos.length === 0) return;

  const entero = (v) => Math.max(0, Math.floor(Number(v) || 0));

  function detalle() {
    const d = {};
    for (const c of campos) {
      const n = entero(c.value);
      if (n > 0) d[c.dataset.denominacion] = n;
    }
    return d;
  }

  function sumar() {
    let contado = 0;
    for (const c of campos) {
      const valor = Number(c.dataset.denominacion);
      const sub = valor * entero(c.value);
      contado += sub;
      const celda = document.querySelector('[data-sub="' + valor + '"]');
      if (celda) {
        celda.textContent = fmt(sub);
        celda.classList.toggle('suave', sub === 0);
      }
    }

    const fondo = entero(base.value);
    const esperado = fondo + A.efectivo - A.gastos;
    const diferencia = contado - esperado;

    $('#cuadreBase').textContent = fmt(fondo);
    $('#cuadreEsperado').textContent = fmt(esperado);
    $('#cuadreContado').textContent = fmt(contado);
    $('#cuadreDiferencia').textContent = (diferencia > 0 ? '+ ' : diferencia < 0 ? '- ' : '') + fmt(Math.abs(diferencia));

    const fila = $('.cuadre-dif');
    fila.classList.toggle('falta', diferencia < 0);
    fila.classList.toggle('sobra', diferencia > 0);
    fila.classList.toggle('cuadra', diferencia === 0 && contado > 0);

    if (contado === 0) veredicto.textContent = 'Todavía no has contado nada.';
    else if (diferencia === 0) veredicto.textContent = 'Cuadra exacto.';
    else if (diferencia < 0) veredicto.textContent = 'Faltan ' + fmt(-diferencia) + ' en el cajón.';
    else veredicto.textContent = 'Hay ' + fmt(diferencia) + ' de más en el cajón.';

    return { contado, esperado, diferencia };
  }

  let borrarAviso = null;
  function avisar(texto, tipo) {
    aviso.textContent = texto;
    aviso.className = 'mensaje ' + (tipo === 'error' ? 'error' : 'ok');
    aviso.hidden = false;
    clearTimeout(borrarAviso);
    if (tipo !== 'error') borrarAviso = setTimeout(() => (aviso.hidden = true), 4000);
  }

  async function pedir(url, datos) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify(datos),
    });
    const cuerpo = await r.json().catch(() => ({ ok: false, error: 'El servidor no contestó bien.' }));
    if (!r.ok || !cuerpo.ok) throw new Error(cuerpo.error || 'No se pudo guardar.');
    return cuerpo;
  }

  for (const c of campos) c.addEventListener('input', sumar);
  base.addEventListener('input', sumar);

  // Enter pasa a la siguiente casilla, como en una calculadora.
  for (let i = 0; i < campos.length; i++) {
    campos[i].addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (i + 1 < campos.length) campos[i + 1].focus();
      else $('#guardarArqueo').click();
    });
  }

  $('#guardarArqueo').addEventListener('click', async (e) => {
    const boton = e.currentTarget;
    boton.disabled = true;
    try {
      const r = await pedir('/almacen/caja/arqueo', {
        fecha: A.fecha,
        detalle: detalle(),
        base: entero(base.value),
        nota: nota.value,
      });
      const d = Number(r.arqueo.diferencia);
      avisar(
        'Conteo guardado. ' +
          (d === 0 ? 'La caja cuadra.' : d < 0 ? 'Faltan ' + fmt(-d) + '.' : 'Sobran ' + fmt(d) + '.'),
        'ok'
      );
      guardado.textContent = 'Guardado. Sale impreso en el cierre y la administración lo ve.';
      const borrar = document.getElementById('borrarArqueo');
      if (borrar) borrar.hidden = false;
    } catch (err) {
      avisar(err.message, 'error');
    } finally {
      boton.disabled = false;
    }
  });

  $('#limpiarArqueo').addEventListener('click', () => {
    for (const c of campos) c.value = '';
    sumar();
    campos[0].focus();
  });

  const botonBorrar = $('#borrarArqueo');
  if (botonBorrar) {
    botonBorrar.addEventListener('click', async () => {
      if (!confirm('¿Borrar el conteo guardado de este día?')) return;
      botonBorrar.disabled = true;
      try {
        await pedir('/almacen/caja/arqueo/borrar', { fecha: A.fecha });
        for (const c of campos) c.value = '';
        base.value = 0;
        nota.value = '';
        sumar();
        botonBorrar.hidden = true;
        botonBorrar.disabled = false;
        guardado.textContent = '';
        avisar('Conteo borrado.', 'ok');
      } catch (err) {
        botonBorrar.disabled = false;
        avisar(err.message, 'error');
      }
    });
  }

  sumar();
})();
