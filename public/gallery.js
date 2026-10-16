// Dev page: draws every card so the art can be reviewed or swapped (see cards.html).
import { renderBack, renderCard } from './cards.js';

const grid = document.getElementById('grid');
const params = new URLSearchParams(location.search);
const only = params.get('ranks'); // e.g. ?ranks=JQK
for (const suit of 'SHDC') {
  for (const rank of 'A23456789TJQK') {
    if (only && !only.includes(rank)) continue;
    const cell = document.createElement('div');
    cell.className = 'gcard';
    cell.append(renderCard(rank + suit));
    grid.append(cell);
  }
}
const back = document.createElement('div');
back.className = 'gcard';
back.append(renderBack());
grid.append(back);
