import { describe, it, expect } from 'vitest'
import { INITIAL_PEOPLE, createInitialPeople, findPerson } from '../utils/people'
import { collidesWithFurniture } from '../utils/collision'

// The floor is rendered at 400px tall on phones and 540px from the tablet
// breakpoint up; the widths below cover phone, tablet and desktop panels.
const FLOORS = [
  { name: 'phone', floorWidth: 375, floorHeight: 400 },
  { name: 'tablet', floorWidth: 640, floorHeight: 540 },
  { name: 'desktop', floorWidth: 900, floorHeight: 540 },
]

describe('Office roster', () => {
  it('has one local avatar and the documented demo colleagues', () => {
    expect(INITIAL_PEOPLE.filter((p) => p.you).map((p) => p.id)).toEqual(['you'])
    expect(INITIAL_PEOPLE.map((p) => p.id)).toEqual([
      'you',
      'maya',
      'leo',
      'sara',
      'noah',
      'ava',
    ])
  })

  it('gives every avatar a unique id', () => {
    const ids = INITIAL_PEOPLE.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('marks every non-local avatar as simulated', () => {
    for (const person of INITIAL_PEOPLE.filter((p) => !p.you)) {
      expect(person.simulated, person.id).toBe(true)
    }
  })

  it('starts every avatar on free floor on every viewport size', () => {
    for (const floor of FLOORS) {
      for (const person of INITIAL_PEOPLE) {
        expect(
          collidesWithFurniture(person.x, person.y, floor),
          `${person.id} overlaps furniture on ${floor.name}`,
        ).toBe(false)
      }
    }
  })

  it('keeps every avatar inside the floor bounds', () => {
    for (const person of INITIAL_PEOPLE) {
      expect(person.x).toBeGreaterThan(0)
      expect(person.x).toBeLessThan(100)
      expect(person.y).toBeGreaterThan(0)
      expect(person.y).toBeLessThan(100)
    }
  })

  it('returns independent copies so a reset cannot mutate the defaults', () => {
    const copy = createInitialPeople()
    expect(copy).toEqual(INITIAL_PEOPLE)
    expect(copy).not.toBe(INITIAL_PEOPLE)
    expect(copy[0]).not.toBe(INITIAL_PEOPLE[0])

    copy[0].x = 999
    expect(INITIAL_PEOPLE[0].x).toBe(48)
    expect(findPerson(INITIAL_PEOPLE, 'you').x).toBe(48)
  })
})
