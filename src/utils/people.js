// The people who populate the virtual office floor.
//
// This is the single source of truth for the roster *and* the default
// positions, so the UI, the layout persistence helpers and the tests all agree
// on where everyone starts.
//
// Every default position below is on free floor: it does not overlap any solid
// furniture from `src/utils/collision.js` for the real 40px avatar.
// `src/__tests__/people.test.js` asserts that.

export const INITIAL_PEOPLE = [
  {
    id: 'you',
    name: 'You',
    role: 'Local User',
    emoji: '🧑🏻‍💻',
    color: '#d9f5e9',
    // Corridor between the two rows of open-workspace desks.
    x: 48,
    y: 66,
    you: true,
    online: true,
    speaking: false,
    simulated: false,
  },
  {
    id: 'maya',
    name: 'Maya Sharma',
    role: 'UX Designer',
    emoji: '👩🏻‍🎨',
    color: '#f5d7c6',
    // Meeting room, on the free floor above the meeting table.
    x: 20,
    y: 7,
    online: true,
    speaking: true,
    simulated: true,
  },
  {
    id: 'leo',
    name: 'Leo Martin',
    role: 'Frontend Engineer',
    emoji: '👨🏼‍💻',
    color: '#d4e3ff',
    x: 51,
    y: 21,
    online: true,
    speaking: false,
    simulated: true,
  },
  {
    id: 'sara',
    name: 'Sara Khan',
    role: 'Product Manager',
    emoji: '👩🏽‍💼',
    color: '#ead9ff',
    x: 81,
    y: 20,
    online: true,
    speaking: false,
    simulated: true,
  },
  {
    id: 'noah',
    name: 'Noah Williams',
    role: 'Developer',
    emoji: '👨🏾‍💻',
    color: '#f8e4ad',
    // Same corridor as the local avatar, further back in the workspace.
    x: 27,
    y: 66,
    online: true,
    speaking: false,
    simulated: true,
  },
  {
    id: 'ava',
    name: 'Ava Chen',
    role: 'Researcher',
    emoji: '👩🏻‍🔬',
    color: '#d2edf3',
    // Quiet studio, clear of both desks and the watercooler.
    x: 84,
    y: 60,
    online: false,
    simulated: true,
  },
]

// A fresh, independent copy of the default roster. `resetLayout` and the
// initial `useState` both use this so no caller can mutate the shared array.
export function createInitialPeople() {
  return INITIAL_PEOPLE.map((person) => ({ ...person }))
}

export function findPerson(people, id) {
  return people.find((person) => person.id === id)
}
