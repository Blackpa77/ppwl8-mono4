import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { cookie } from "@elysiajs/cookie";
import { prisma } from "../prisma/db";
import { createOAuthClient, getAuthUrl } from "./auth";
import { getCourses, getCourseWorks, getSubmissions } from "./classroom";
import type { ApiResponse, HealthCheck, User } from "shared";

const tokenStore = new Map<string, { access_token: string; refresh_token?: string }>();

const isBrowserRequest = (request: Request): boolean => {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html") && !origin && !referer;
};

const app = new Elysia()
  // 1. KITA HARDCODE CORS PERSIS MONO 3 AGAR TIDAK CRASH KARENA BINTANG (*)
  .use(cors({ 
    origin: ["http://localhost:5173", "http://localhost:5174", "http://127.0.0.1:5173"], 
    credentials: true 
  }))
  .use(swagger())
  .use(cookie())

  .onRequest(({ request, set }) => {
    const origin = request.headers.get("origin");
    const frontendUrl = "http://localhost:5173"; // Kita hardcode biar super aman

    if (origin && origin === frontendUrl) return;

    if (isBrowserRequest(request)) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/auth")) return; // JALUR VIP LOGIN

      const key = url.searchParams.get("key");
      if (!key || key !== process.env.API_KEY) {
        set.status = 401;
        return { message: "Unauthorized: missing or invalid key" };
      }
    }
  })

  .get("/", (): ApiResponse<HealthCheck> => ({
    data: { status: "ok" },
    message: "server running",
  }))

  .get("/users", async () => {
    const users = await prisma.user.findMany();
    return { data: users, message: "User list retrieved" } as ApiResponse<User[]>;
  })

  .get("/auth/login", ({ redirect }) => {
    const oauth2Client = createOAuthClient();
    return redirect(getAuthUrl(oauth2Client));
  })

  .get("/auth/callback", async ({ query, set, cookie: { session }, redirect }) => {
    const { code } = query as { code: string };

    if (!code) {
      set.status = 400;
      return { error: "Missing authorization code" };
    }

    const oauth2Client = createOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    const sessionId = crypto.randomUUID();
    tokenStore.set(sessionId, {
      access_token: tokens.access_token!,
      refresh_token: tokens.refresh_token ?? undefined,
    });

    if (session) {
      session.value = sessionId;
      session.maxAge = 60 * 60 * 24; 
      session.path = "/"; // Pastikan kuki dibaca merata
    }

    // REDIRECT DIHARDCODE SEPERTI MONO 3
    return redirect("http://localhost:5173/classroom");
  })

  .get("/auth/me", ({ cookie: { session } }) => {
    const sessionId = session?.value as string;
    if (!sessionId || !tokenStore.has(sessionId)) {
      return { loggedIn: false };
    }
    return { loggedIn: true, sessionId };
  })

  .post("/auth/logout", ({ cookie: { session } }) => {
    if (!session) return { success: false };

    const sessionId = session?.value as string;
    if (sessionId) {
      tokenStore.delete(sessionId);
      session.remove();
    }
    return { success: true };
  })

  .get("/classroom/courses", async ({ cookie: { session }, set }) => {
    const sessionId = session?.value as string;
    const tokens = sessionId ? tokenStore.get(sessionId) : null;

    if (!tokens) {
      set.status = 401;
      return { error: "Unauthorized. Silakan login terlebih dahulu." };
    }

    const courses = await getCourses(tokens.access_token);
    return { data: courses, message: "Courses retrieved" };
  })

  .get("/classroom/courses/:courseId/submissions", async ({ params, cookie: { session }, set }) => {
    const sessionId = session?.value as string;
    const tokens = sessionId ? tokenStore.get(sessionId) : null;

    if (!tokens) {
      set.status = 401;
      return { error: "Unauthorized. Silakan login terlebih dahulu." };
    }

    const [courseWorks, submissions] = await Promise.all([
      getCourseWorks(tokens.access_token, params.courseId),
      getSubmissions(tokens.access_token, params.courseId),
    ]);

    const submissionMap = new Map(submissions.map((s: any) => [s.courseWorkId, s]));

    const result = courseWorks.map((cw: any) => ({
      courseWork: cw,
      submission: submissionMap.get(cw.id) ?? null,
    }));

    return { data: result, message: "Course submissions retrieved" };
  });

if (process.env.NODE_ENV !== "production") {
  app.listen(3000);
  console.log(`🦊 Backend → http://localhost:3000`);
  console.log(`🦊 TEST_URL: ${process.env.TEST_URL}`);
  console.log(`🦊 DATABASE_URL: ${process.env.DATABASE_URL}`);
}

export default app;
export type App = typeof app;