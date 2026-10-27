import { describe, it, expect } from 'vitest';
import { renderSettled } from './officeHarness';
import VirtualOffice from '../pages/VirtualOffice';
import { FURNITURE, OFFICE_LAYOUT, furnitureToFloorRect } from '../utils/collision';

describe('Virtual office floor rendering', () => {
  it('renders every room from the shared layout', async () => {
    const { container } = await renderSettled(<VirtualOffice onHome={() => {}} />);

    for (const room of OFFICE_LAYOUT.rooms) {
      expect(container.querySelector(`[data-room-id="${room.id}"]`), room.id).toBeTruthy();
    }
  });

  it('renders every solid furniture item from the shared layout', async () => {
    const { container } = await renderSettled(<VirtualOffice onHome={() => {}} />);

    const rendered = [...container.querySelectorAll('[data-furniture-id]')].map((el) =>
      el.getAttribute('data-furniture-id'),
    );

    expect(rendered).toHaveLength(FURNITURE.length);
    for (const item of FURNITURE) {
      expect(rendered, item.id).toContain(item.id);
    }
  });

  it('draws every furniture item at the exact rectangle the collision model uses', async () => {
    const { container } = await renderSettled(<VirtualOffice onHome={() => {}} />);

    for (const room of OFFICE_LAYOUT.rooms) {
      for (const item of room.furniture) {
        const rect = furnitureToFloorRect(room, item);
        const el = container.querySelector(`[data-furniture-id="${item.id}"]`);
        expect(el, item.id).toBeTruthy();
        // Floor percentages, so drawn geometry == collision geometry.
        expect(parseFloat(el.style.left), `${item.id} x`).toBeCloseTo(rect.x, 6);
        expect(parseFloat(el.style.top), `${item.id} y`).toBeCloseTo(rect.y, 6);
        expect(parseFloat(el.style.width), `${item.id} w`).toBeCloseTo(rect.w, 6);
        expect(parseFloat(el.style.height), `${item.id} h`).toBeCloseTo(rect.h, 6);
      }
    }
  });

  it('centers the avatar circle on its stored percentage position', async () => {
    const { container } = await renderSettled(<VirtualOffice onHome={() => {}} />);

    // The container is anchored so that the 40px circle - not the label block -
    // is centered on (x, y). Anything else would put the drawn avatar, the
    // earshot ring and the collision footprint in different places.
    const avatar = container.querySelector('.office-floor [aria-label^="You,"]');
    expect(avatar.className).toContain('-translate-y-[20px]');
    expect(avatar.firstElementChild.className).toContain('h-10');
    expect(avatar.firstElementChild.className).toContain('w-10');
  });
});
