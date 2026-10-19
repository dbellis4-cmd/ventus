export const categories = [
  { id: "classes", name: "Classes", calendar: true, deadline: false },
  { id: "meetings", name: "Meetings", calendar: true, deadline: false },
  { id: "assignments", name: "Assignments", calendar: true, deadline: true },
  { id: "professional", name: "Professional events", calendar: true, deadline: false },
  { id: "social", name: "Social events", calendar: true, deadline: false },
  { id: "personal", name: "Personal tasks", calendar: false, deadline: false },
  { id: "misc", name: "Miscellaneous tasks", calendar: false, deadline: false },
] as const;

export type Task = {
  id: string;
  title: string;
  category: string;
  date: string;
  time: string;
  endTime: string;
  location: string;
  recurrence: string;
  recurrenceEnd: string;
  calendar: boolean;
  status: "open" | "completed" | "canceled";
  completedOn?: string;
  parentId?: string;
};

export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// Local noon avoids UTC date parsing and ordinary daylight-saving boundaries.
export function parseDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

export function addDays(value: string, days: number): string {
  const date = parseDate(value);
  date.setDate(date.getDate() + days);
  return dateKey(date);
}

export function startOfWeek(value: string): string {
  return addDays(value, -parseDate(value).getDay());
}

export function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && dateKey(parseDate(value)) === value;
}

export function formatDate(value: string, options: Intl.DateTimeFormatOptions): string {
  return parseDate(value).toLocaleDateString("en-US", options);
}

export function formatTime(value: string): string {
  if (!value) return "";
  const [hours, minutes] = value.split(":").map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
}

export function categoryFor(id: string) {
  return categories.find((category) => category.id === id) ?? categories[5];
}

export function sampleTasks(today: string): Task[] {
  const make = (id: string, title: string, offset: number, category: string, time = "", extra: Partial<Task> = {}): Task => ({
    id, title, date: addDays(today, offset), category, time,
    endTime: "", location: "", recurrence: "", recurrenceEnd: "", calendar: categoryFor(category).calendar,
    status: "open", ...extra,
  });
  return [
    make("reading", "Read the strategy case study", 0, "classes", "08:30", { status: "completed", completedOn: today }),
    make("review", "Project check-in", 0, "meetings", "10:00", { location: "Library, room 204" }),
    make("seminar", "Product strategy seminar", 0, "classes", "14:00", { location: "Business school" }),
    make("paper", "Outline the research paper", 0, "assignments"),
    make("walk", "Take an evening walk", 0, "personal", "", { recurrence: "daily" }),
    make("overdue", "Submit the research proposal", -2, "assignments"),
    make("yesterday", "Meet Alex for coffee", -1, "social", "11:00"),
    make("gym", "Strength training", 1, "personal", "07:00", { recurrence: "weekly" }),
    make("draft", "Write the first draft", 1, "assignments", "", { parentId: "paper" }),
    make("groceries", "Pick up groceries", 1, "personal"),
    make("workshop", "Design workshop", 2, "professional", "13:00"),
    make("feedback", "Get feedback on the draft", 2, "assignments", "", { parentId: "paper" }),
    make("submit", "Submit the final paper", 3, "assignments"),
    make("dinner", "Dinner with friends", 4, "social", "18:30"),
    make("reset", "Plan the coming week", 6, "personal"),
  ];
}
