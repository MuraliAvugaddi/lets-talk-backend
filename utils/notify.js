// =====================================================
// 🔔 WHAT each notification says (one place → easy to change the words)
// All functions run in the background: they never slow down or break an API.
// =====================================================
const push = require("./push");

const langStage = (language, stage) =>
  `${language === "Hindi" ? "Hindi" : "English"} ${String(stage || "").replace(/stage/i, "Stage ")}`.trim();

const notify = {
  // 📢 admin notice → online / offline / all students
  notice: (message, targetMode) =>
    push.later(() =>
      push.toTopic(push.topicForTarget(targetMode), {
        title: "📢 Let's Speak notice",
        body: message,
        data: { click: "home", type: "notice" },
      })
    ),

  // 🎙 special class set for today
  specialClassSet: (title, startTime) =>
    push.later(() =>
      push.toTopic("students", {
        title: `🎙 ${title || "Surendra Sir Special Class"}`,
        body: `Today at ${startTime}. Join from the app on time — attendance is counted.`,
        data: { click: "assembly", type: "assembly" },
      })
    ),

  // ⏰ special class starts in 10 minutes
  specialClassSoon: (title, startTime) =>
    push.later(() =>
      push.toTopic("students", {
        title: `⏰ ${title || "Special class"} starts in 10 minutes`,
        body: `Starts at ${startTime}. Open the app and join.`,
        data: { click: "assembly", type: "assembly" },
      })
    ),

  // 🌧 offline classes are online today
  //    stages = ["stage1","stage3"] → only those stages (empty = all)
  rainDay: (reason, stages = []) =>
    push.later(() =>
      push.toTopic("mode_offline", {
        title: stages && stages.length
          ? `🌧 ${stages.map((s) => s.replace("stage", "Stage ")).join(", ")}: class is ONLINE today`
          : "🌧 Today's class is ONLINE",
        body: `${reason ? `${reason}. ` : ""}${
          stages && stages.length
            ? "Offline students of these stages: join from the app at your usual time. Other stages come to the institute as usual."
            : "Offline students: join your class from the app today at your usual time."
        }`,
        data: { click: "home", type: "rain" },
      })
    ),

  // ✅ ⏰ ❌ attendance
  attendance: (userId, status, { language, stage, lateByMinutes } = {}) => {
    const what = langStage(language, stage);
    const text = {
      Present: { title: "✅ Attendance: Present", body: `You are marked present for ${what} today. Keep it up!` },
      Late: {
        title: "⏰ Attendance: Late",
        body: `You were ${lateByMinutes ? `${lateByMinutes} min ` : ""}late for ${what} today. Please come on time.`,
      },
      Absent: { title: "❌ Attendance: Absent", body: `You were absent for ${what} today. Don't miss tomorrow's class!` },
    }[status];
    if (!text) return;
    push.later(() => push.toUsers(userId, { ...text, data: { click: "attendance", type: "attendance" } }));
  },

  // 🎉 new stage unlocked
  stageUnlocked: (userId, language, stageNumbers) => {
    if (!stageNumbers.length) return;
    const list = stageNumbers.map((n) => `Stage ${n}`).join(", ");
    push.later(() =>
      push.toUsers(userId, {
        title: "🎉 Congratulations!",
        body: `You are promoted — ${language} ${list} is now open for you.`,
        data: { click: "home", type: "stage" },
      })
    );
  },

  // 🔄 admin changed online / offline
  //    extra = "Only till 8 Nov. After that you are offline again." (temporary change)
  modeChanged: (user, extra = "") =>
    push.later(async () => {
      await push.syncTopics(user);
      await push.toUsers(user._id, {
        title: user.mode === "online" ? "🔄 You are now an ONLINE student" : "🔄 You are now an OFFLINE student",
        body:
          (user.mode === "online"
            ? "Join your classes from the app (live audio class)."
            : "Come to the institute and check in with 'I Am Here'.") + (extra ? ` ${extra}` : ""),
        data: { click: "home", type: "mode" },
      });
    }),

  // 📝 new test is live for one language + stage → only those students
  testReleased: (language, stage) =>
    push.later(async () => {
      const User = require("../Models/users");
      const key = language === "Hindi" ? "hindiAccess" : "englishAccess";
      const ids = await User.find({ role: "student", [`${key}.${stage}`]: true }).distinct("_id");
      if (!ids.length) return;
      await push.toUsers(ids, {
        title: "📝 New test is live!",
        body: `${langStage(language, stage)} test is open now. Please complete it on time.`,
        data: { click: "tests", type: "test" },
      });
    }),

  // 💳 fee
  feeApproved: (userId) =>
    push.later(() =>
      push.toUsers(userId, {
        title: "✅ Fee received",
        body: "Thank you! Your fee for this month is confirmed.",
        data: { click: "fees", type: "fee" },
      })
    ),
  feeRejected: (userId) =>
    push.later(() =>
      push.toUsers(userId, {
        title: "⚠️ Fee screenshot not accepted",
        body: "Please check and upload your payment screenshot again.",
        data: { click: "fees", type: "fee" },
      })
    ),
  feeReminder: () =>
    push.later(() =>
      push.toTopic("students", {
        title: "💳 Monthly fee reminder",
        body: "A new month has started. Please pay your fee and upload the screenshot in the app.",
        data: { click: "fees", type: "fee" },
      })
    ),
};

module.exports = notify;
