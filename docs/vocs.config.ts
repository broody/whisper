import { defineConfig } from "vocs/config";

export default defineConfig({
  title: "Whisper",
  titleTemplate: "%s · Whisper Docs",
  description:
    "How Whisper builds private Vickrey auctions with encrypted STRK20 notes on Starknet.",
  accentColor: "light-dark(#6d28d9, #a78bfa)",
  topNav: [
    { text: "Guide", link: "/how-whisper-works", match: "/" },
    { text: "GitHub", link: "https://github.com/broody/whisper" },
  ],
  sidebar: [
    {
      text: "Start here",
      items: [
        { text: "Whisper overview", link: "/" },
        { text: "How Whisper works", link: "/how-whisper-works" },
      ],
    },
    {
      text: "Core concepts",
      items: [
        { text: "Encrypted notes", link: "/concepts/encrypted-notes" },
        { text: "Bid lifecycle", link: "/auctions/bid-lifecycle" },
        { text: "Auction fulfillment", link: "/auctions/fulfillment" },
      ],
    },
    {
      text: "Implementation",
      items: [
        { text: "Operator architecture", link: "/architecture/operator" },
        { text: "Rejected-bid recovery", link: "/operations/rejected-bid-recovery" },
        { text: "Privacy & trust", link: "/security/privacy-and-trust" },
        { text: "Development status", link: "/operations/development-status" },
      ],
    },
  ],
  socials: [
    {
      icon: "github",
      link: "https://github.com/broody/whisper",
    },
  ],
});
