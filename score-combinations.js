const questions = [
  { name: 'Q1', correct: 10, wrong: 3 },
  { name: 'Q2', correct: 10, wrong: 3 },
  { name: 'Q3', correct: 20, wrong: 5 },
  { name: 'Q4', correct: 20, wrong: 5 },
  { name: 'Q5', correct: 30, wrong: 8 },
  { name: 'Bonus', correct: 50, wrong: 13 },
];

const players = [
  { name: 'Score53', score: 53 }
];

function findCombinations(targetScore) {
  const results = [];
  for (let mask = 0; mask < 64; mask++) {
    for (const completed of [true, false]) {
      let total = completed ? 10 : 0;
      const answers = [];
      for (let i = 0; i < 6; i++) {
        const correct = (mask >> i) & 1;
        total += correct ? questions[i].correct : questions[i].wrong;
        answers.push(correct ? '✓' : '✗');
      }
      if (total === targetScore) {
        results.push({ pattern: answers.join(' '), completed, total });
      }
    }
  }
  return results;
}

for (const player of players) {
  const combos = findCombinations(player.score);
  console.log(`\n${player.name} — ${player.score} pts`);
  if (combos.length === 0) {
    console.log('  No valid combinations found');
  } else {
    combos.forEach(c => {
      console.log(`  ${c.pattern} | completed: ${c.completed}`);
    });
    console.log(`  (${combos.length} possible combination${combos.length === 1 ? '' : 's'})`);
  }
}