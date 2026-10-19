// =====================================================
// ⏰ ATTENDANCE TIME RULES (IST) — one place for every screen
//
// STUDENTS (online + offline): 7 timings. On time = join by start + 7 min.
//   05:30 AM class → join by 05:37 AM = Present, after that = Late (minutes late are shown).
//   Online: minutes in class + every join/leave are recorded. Offline (GPS): only the check-in time.
//
// TRAINERS: two attendances a day.
//   Morning shift   05:30 AM → join 05:25–05:27 AM = Present, after 05:27 = Late
//   Afternoon shift 03:00 PM → join 02:55–02:57 PM = Present, after 02:57 = Late
//   (joining even earlier than the window is fine = Present)
//
// Change on Render → Environment if the institute changes its timings:
//   STUDENT_GRACE_MIN=7  TRAINER_MORNING_START=05:30  TRAINER_AFTERNOON_START=15:00
//   TRAINER_ON_TIME_BEFORE_MIN=3  TRAINER_WINDOW_BEFORE_MIN=5  TRAINER_SHIFT_SPLIT=12:00
// =====================================================
const { parseClockToMinutes, istMinutesOfDay } = require("./time");

const num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v !== undefined ? Number(v) : d);
const clock = (v, d) => {
  const m = v ? parseClockToMinutes(String(v)) : null;
  return m === null || m === undefined ? d : m;
};

const STUDENT_GRACE_MIN = num(process.env.STUDENT_GRACE_MIN, 7);
const TRAINER_WINDOW_BEFORE_MIN = num(process.env.TRAINER_WINDOW_BEFORE_MIN, 5);
const TRAINER_ON_TIME_BEFORE_MIN = num(process.env.TRAINER_ON_TIME_BEFORE_MIN, 3);
const SHIFT_SPLIT = clock(process.env.TRAINER_SHIFT_SPLIT, 12 * 60);

const SHIFTS = [
  { key: "morning", label: "Morning shift", start: clock(process.env.TRAINER_MORNING_START, 5 * 60 + 30) },
  { key: "afternoon", label: "Afternoon shift", start: clock(process.env.TRAINER_AFTERNOON_START, 15 * 60) },
];
const SHIFT_LABELS = SHIFTS.map((s) => s.label);

const pad = (n) => String(n).padStart(2, "0");
const fmtClock = (mins) => {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${pad(h12)}:${pad(m % 60)} ${h < 12 ? "AM" : "PM"}`;
};

const shiftAt = (mins) => (mins < SHIFT_SPLIT ? SHIFTS[0] : SHIFTS[1]);
const shiftByKey = (key) => SHIFTS.find((s) => s.key === key) || null;

/** Trainer joined / checked in at `mins` (IST minutes) */
const trainerArrival = (mins) => {
  const shift = shiftAt(mins);
  const onTimeUntil = shift.start - TRAINER_ON_TIME_BEFORE_MIN;
  const late = mins > onTimeUntil;
  return {
    shift: shift.key,
    shiftLabel: shift.label,
    status: late ? "Late" : "Present",
    lateByMinutes: late ? mins - onTimeUntil : 0,
    window: `${fmtClock(shift.start - TRAINER_WINDOW_BEFORE_MIN)} – ${fmtClock(onTimeUntil)}`,
  };
};

/** Student joined their class (batch label like "05:30 AM - 07:00 AM") at `mins` */
const studentArrival = (mins, batchLabel) => {
  const start = parseClockToMinutes(batchLabel);
  if (start === null || start === undefined) return { status: "Present", lateByMinutes: 0, onTimeUntil: "" };
  const onTimeUntil = start + STUDENT_GRACE_MIN;
  const late = mins > onTimeUntil;
  return { status: late ? "Late" : "Present", lateByMinutes: late ? mins - onTimeUntil : 0, onTimeUntil: fmtClock(onTimeUntil) };
};

/** Which shift an existing trainer record belongs to (old records: from their time) */
const shiftOfRecord = (r) => {
  if (!r) return null;
  if (r.shift && shiftByKey(r.shift)) return r.shift;
  const byLabel = SHIFTS.find((s) => s.label === r.batchTime);
  if (byLabel) return byLabel.key;
  const t = r.markedAt || r.firstJoinAt || r.joinTime || r.createdAt;
  return t ? shiftAt(istMinutesOfDay(new Date(t))).key : "morning";
};

const rulesSummary = () => ({
  studentGraceMinutes: STUDENT_GRACE_MIN,
  trainerShifts: SHIFTS.map((s) => ({
    key: s.key,
    label: s.label,
    start: fmtClock(s.start),
    window: `${fmtClock(s.start - TRAINER_WINDOW_BEFORE_MIN)} – ${fmtClock(s.start - TRAINER_ON_TIME_BEFORE_MIN)}`,
  })),
});

module.exports = {
  STUDENT_GRACE_MIN,
  SHIFTS,
  SHIFT_LABELS,
  shiftAt,
  shiftByKey,
  trainerArrival,
  studentArrival,
  shiftOfRecord,
  fmtClock,
  rulesSummary,
};
