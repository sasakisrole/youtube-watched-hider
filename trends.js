// Trends panel: cumulative total + daily new chart.
// Reads from `allData` (loaded by history.js).
(() => {
  let chartTotal = null;
  let chartDaily = null;
  let currentRange = 30; // days, or 'all'
  let clipOutliers = true;

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  function computeClipCap(values) {
    const nonzero = values.filter(v => v > 0).slice().sort((a, b) => a - b);
    if (nonzero.length < 5) return null;
    const p95 = percentile(nonzero, 0.95);
    const max = nonzero[nonzero.length - 1];
    // Only clip when there's a real spike: max is > 3x of P95.
    if (max <= p95 * 3) return null;
    // Cap at P95 * 1.5 (with a floor so very small datasets aren't squashed).
    return Math.max(Math.ceil(p95 * 1.5), 10);
  }

  function getCSSVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function dayStartMs(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  }

  function buildSeries(records, rangeDays) {
    if (!records || records.length === 0) return { labels: [], cumulative: [], dailyNew: [] };

    const newByDay = new Map();
    let earliest = Infinity;
    let latest = -Infinity;
    for (const r of records) {
      const ts = r.firstWatchedAt || r.watchedAt;
      if (!ts) continue;
      const k = dayKey(ts);
      newByDay.set(k, (newByDay.get(k) || 0) + 1);
      if (ts < earliest) earliest = ts;
      if (ts > latest) latest = ts;
    }
    if (!isFinite(earliest)) return { labels: [], cumulative: [], dailyNew: [] };

    // Determine display range.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let startDate;
    if (rangeDays === 'all') {
      startDate = new Date(earliest);
      startDate.setHours(0, 0, 0, 0);
    } else {
      startDate = new Date(today);
      startDate.setDate(startDate.getDate() - (rangeDays - 1));
    }

    // Cumulative count up to (but not including) startDate.
    let cumBase = 0;
    for (const r of records) {
      const ts = r.firstWatchedAt || r.watchedAt;
      if (ts && ts < startDate.getTime()) cumBase++;
    }

    const labels = [];
    const cumulative = [];
    const dailyNew = [];
    let running = cumBase;
    const cursor = new Date(startDate);
    while (cursor <= today) {
      const k = dayKey(cursor.getTime());
      const n = newByDay.get(k) || 0;
      running += n;
      labels.push(k);
      cumulative.push(running);
      dailyNew.push(n);
      cursor.setDate(cursor.getDate() + 1);
    }
    return { labels, cumulative, dailyNew };
  }

  function updateKpis(records) {
    const total = records.length;
    const todayStart = dayStartMs(new Date());
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    let monthNew = 0;
    let todayNew = 0;
    let todayRewatched = 0;
    for (const r of records) {
      const fw = r.firstWatchedAt || r.watchedAt;
      const wa = r.watchedAt || 0;
      if (fw && fw >= monthStart.getTime()) monthNew++;
      if (fw && fw >= todayStart) todayNew++;
      else if (wa >= todayStart) todayRewatched++;
    }
    document.getElementById('trAllTime').textContent = total.toLocaleString();
    document.getElementById('trThisMonth').textContent = monthNew.toLocaleString();
    document.getElementById('trToday').textContent = `${todayNew}/${todayRewatched}`;
  }

  function chartCommonOpts() {
    const muted = getCSSVar('--text-muted') || '#71717a';
    const border = getCSSVar('--border') || '#e8e8e8';
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: getCSSVar('--surface') || '#fff', titleColor: getCSSVar('--text') || '#000', bodyColor: getCSSVar('--text') || '#000', borderColor: border, borderWidth: 1 },
      },
      scales: {
        x: {
          ticks: { color: muted, maxTicksLimit: 8, autoSkip: true },
          grid: { color: border, drawTicks: false },
        },
        y: {
          beginAtZero: false,
          ticks: { color: muted, callback: v => v.toLocaleString() },
          grid: { color: border, drawTicks: false },
        },
      },
    };
  }

  function renderCharts(series) {
    const accent = getCSSVar('--accent') || '#3f3f9c';
    const accentSoft = getCSSVar('--accent-soft') || '#eeeefc';

    if (chartTotal) chartTotal.destroy();
    chartTotal = new Chart(document.getElementById('trChartTotal'), {
      type: 'line',
      data: {
        labels: series.labels,
        datasets: [{
          data: series.cumulative,
          borderColor: accent,
          backgroundColor: accentSoft,
          fill: true,
          tension: 0.25,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2,
        }],
      },
      options: chartCommonOpts(),
    });

    const dailyOpts = chartCommonOpts();
    dailyOpts.scales.y.beginAtZero = true;

    const original = series.dailyNew;
    const cap = clipOutliers ? computeClipCap(original) : null;
    const displayValues = cap == null ? original.slice() : original.map(v => v > cap ? cap : v);
    const clippedIdx = cap == null ? new Set() : new Set(original.map((v, i) => v > cap ? i : -1).filter(i => i >= 0));

    if (cap != null) {
      dailyOpts.scales.y.max = Math.ceil(cap * 1.05);
      dailyOpts.plugins.tooltip.callbacks = {
        label: (ctx) => {
          const real = original[ctx.dataIndex];
          return clippedIdx.has(ctx.dataIndex) ? `${real.toLocaleString()} (圧縮表示)` : real.toLocaleString();
        },
      };
    }

    const clipLabelPlugin = {
      id: 'trClipLabels',
      afterDatasetsDraw(chart) {
        if (!clippedIdx.size) return;
        const { ctx, scales: { y } } = chart;
        const meta = chart.getDatasetMeta(0);
        ctx.save();
        ctx.fillStyle = getCSSVar('--accent-strong') || getCSSVar('--accent') || '#3f3f9c';
        ctx.font = '600 10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        for (const i of clippedIdx) {
          const bar = meta.data[i];
          if (!bar) continue;
          const real = original[i];
          ctx.fillText(`↑${real.toLocaleString()}`, bar.x, y.top + 10);
        }
        ctx.restore();
      },
    };

    if (chartDaily) chartDaily.destroy();
    chartDaily = new Chart(document.getElementById('trChartDaily'), {
      type: 'bar',
      data: {
        labels: series.labels,
        datasets: [{
          data: displayValues,
          backgroundColor: accent,
          borderRadius: 2,
        }],
      },
      options: dailyOpts,
      plugins: [clipLabelPlugin],
    });
  }

  function renderTrends() {
    const records = (typeof allData !== 'undefined' && allData) ? allData : [];
    updateKpis(records);
    const range = currentRange === 'all' ? 'all' : Number(currentRange);
    const series = buildSeries(records, range);
    renderCharts(series);
  }

  // Range buttons + clip toggle
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.tr-range-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tr-range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentRange = btn.dataset.range === 'all' ? 'all' : Number(btn.dataset.range);
        renderTrends();
      });
    });
    const clipChk = document.getElementById('trClipOutliers');
    if (clipChk) {
      clipChk.addEventListener('change', () => {
        clipOutliers = clipChk.checked;
        renderTrends();
      });
    }
  });

  // Expose for analyzer.js tab handler
  window.renderTrends = renderTrends;
})();
