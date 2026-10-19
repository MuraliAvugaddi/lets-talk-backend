const mongoose = require("mongoose");

// A poster and/or Instagram-style reel the admin shows on the student home screen
// (e.g. "Dussehra — 10 days to go"). Files live on Cloudinary.
const mediaShape = {
  url: { type: String, default: "" }, // what the apps load
  originalUrl: { type: String, default: "" }, // fallback (untransformed upload)
  thumbUrl: { type: String, default: "" }, // video only: first-second frame
  publicId: { type: String, default: "" },
  width: { type: Number, default: 0 },
  height: { type: Number, default: 0 },
  duration: { type: Number, default: 0 }, // seconds (video)
  bytes: { type: Number, default: 0 },
};

const promoSchema = new mongoose.Schema(
  {
    title: { type: String, default: "", trim: true, maxlength: 120 },
    caption: { type: String, default: "", trim: true, maxlength: 500 },
    targetMode: { type: String, enum: ["all", "online", "offline"], default: "all" },
    image: { type: mediaShape, default: () => ({}) },
    video: { type: mediaShape, default: () => ({}) },
    // Instagram reel / post link pasted by the admin (played inside the app with Instagram's embed player)
    instagram: {
      url: { type: String, default: "" }, // clean link: https://www.instagram.com/reel/CODE/
      code: { type: String, default: "" },
      kind: { type: String, default: "" }, // reel | p | tv
    },
    active: { type: Boolean, default: true },
    endsAt: { type: Date, default: null }, // hide automatically after this time (null = until turned off)
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    createdByName: { type: String, default: "" },
  },
  { timestamps: true }
);

promoSchema.index({ active: 1, targetMode: 1, createdAt: -1 });

module.exports = mongoose.models.Promo || mongoose.model("Promo", promoSchema);
