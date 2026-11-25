// Hybrid logical clock.
// Stamps look like "0mxxxxxxx.00000.<writerId>" and sort correctly as plain
// strings. Rule that matters: once you have SEEN someone's change, any change
// you make afterwards gets a bigger stamp - even if your PC clock is behind.
// So "the last edit made after seeing the other one" always wins.

const WALL_W = 9;
const CNT_W = 5;

export function encodeStamp(wall: number, counter: number, writer: string): string {
  return wall.toString(36).padStart(WALL_W, '0') + '.' + counter.toString(36).padStart(CNT_W, '0') + '.' + writer;
}

export function decodeStamp(s: string): { wall: number; counter: number; writer: string } {
  const wall = parseInt(s.slice(0, WALL_W), 36);
  const counter = parseInt(s.slice(WALL_W + 1, WALL_W + 1 + CNT_W), 36);
  const writer = s.slice(WALL_W + CNT_W + 2);
  return { wall, counter, writer };
}

export class Clock {
  private wall = 0;
  private counter = 0;
  constructor(public readonly writer: string, private readonly now: () => number = Date.now) {}

  tick(): string {
    const n = this.now();
    if (n > this.wall) {
      this.wall = n;
      this.counter = 0;
    } else {
      this.counter++;
    }
    return encodeStamp(this.wall, this.counter, this.writer);
  }

  observe(stamp: string): void {
    const { wall, counter } = decodeStamp(stamp);
    if (!Number.isFinite(wall)) return;
    if (wall > this.wall) {
      this.wall = wall;
      this.counter = counter;
    } else if (wall === this.wall && counter > this.counter) {
      this.counter = counter;
    }
  }
}
