/**
 * accounts.js
 * Jazz Bar only for now — add more accounts here later.
 */

const ACCOUNTS = {

  jazzbar: {
    name: "Jazz Bar",
    pageId: process.env.JAZZBAR_PAGE_ID,
    accessToken: process.env.JAZZBAR_ACCESS_TOKEN,
    emoji: "🎷",

    venueInfo: {
      location: "Corniche, Abu Dhabi",
      liveMusicDays: ["Thursday", "Friday", "Saturday"],
      happyHour: "6 PM - 8 PM daily",
      dressCode: "Smart casual",
      reservations:
        "https://www.sevenrooms.com/reservations/jazzbarabudhabi",
      menu: ["Cocktails", "Wines", "Spirits", "Bar bites"],
      coverCharge: false,
    },

    events: {

      thursday: {
        title: "Chady Nashef Live",
        artist: "Chady Nashef",
        days: ["Thursday"],

        timings: {
          band: "8:30 PM",
          vocals: "9:15 PM",
        },

        offers: {
          openBar: {
            price: "199 AED",
            details: "Selected drinks",
          },
        },

        description:
          "Live performance by Chady Nashef and the band every Thursday night.",
      },

      fridayLadiesNight: {
        title: "Ladies Night",
        days: ["Friday"],

        timings: {
          offerStart: "7 PM",
          offerEnd: "11 PM",
          band: "8:45 PM",
          vocals: "9:45 PM",
        },

        offers: {
          ladiesNight: {
            price: "109 AED",
            includes: [
              "5 signature drinks",
              "20% off the menu",
            ],
          },
        },

        description:
          "Friday ladies night with live music, signature drinks, and special offers.",
      },

      davidHowardWeekend: {
        title: "David Howard Live",
        artist: "David Howard",
        days: ["Friday", "Saturday"],

        timings: {
          band: "8:45 PM",
          vocals: "9:45 PM",
        },

        description:
          "Live performance by David Howard and the band every Friday and Saturday.",
      },

    },

    systemPrompt: `
You are the social media manager for Jazz Bar, a live music bar and cocktail lounge.

Key info:
- Live music: Thu, Fri, Sat
- Happy hour: 6 PM - 8 PM daily
- No cover charge
- Dress code: Smart casual
- Reservations: Via DM or at https://www.sevenrooms.com/reservations/jazzbarabudhabi
- Menu: Cocktails, wines, spirits, bar bites
- Located at Radisson Blu Corniche, Abu Dhabi

Rules:
- Never use emojis
- Never use more than one exclamation mark
- Keep replies under 3 sentences
- Never invent performers or events
- Reply ONLY with the message text

Tone A - Warm and friendly
Tone B - Sophisticated and cool
Tone C - Direct and concise

Always write all 3 tones when asked.
    `.trim(),
  },

};

module.exports = ACCOUNTS;
