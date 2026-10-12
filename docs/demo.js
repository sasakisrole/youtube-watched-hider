(() => {
  const toggle=document.querySelector('#toggle'),grid=document.querySelector('#video-grid'),title=document.querySelector('#demo-title'),status=document.querySelector('#demo-status');
  if(!toggle||!grid)return;
  const text=document.documentElement.lang==='en'
    ?{hiddenTitle:'Three videos still to watch.',shownTitle:'The original list: six videos.',hidden:'Of six videos, the three watched ones are hidden.',shown:'All six videos are shown. Coffee, piano and stars are watched.'}
    :{hiddenTitle:'まだ観ていない、3本。',shownTitle:'元の一覧、6本。',hidden:'6本のうち、視聴済みの3本を隠しています。',shown:'元の6本を表示しています。視聴済みはコーヒー・ピアノ・星空です。'};
  toggle.hidden=false;
  toggle.addEventListener('click',()=>{
    const hide=toggle.getAttribute('aria-pressed')!=='true';
    toggle.setAttribute('aria-pressed',String(hide));
    grid.classList.toggle('hide-watched',hide);
    // The accessible toggle name stays constant; aria-pressed carries its state.
    title.textContent=hide?text.hiddenTitle:text.shownTitle;
    status.textContent=hide?text.hidden:text.shown;
  });
})();
