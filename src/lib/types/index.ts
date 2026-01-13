export interface User {
  id: string;
  email: string;
  role: string;
  orgId?: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  theme?: Record<string, string>;
}

export interface Course {
  id: string;
  title: string;
  description: string;
  orgId: string;
}

export interface Test {
  id: string;
  title: string;
  courseId: string;
}

export interface Certificate {
  id: string;
  userId: string;
  courseId: string;
  issuedAt: Date;
}

