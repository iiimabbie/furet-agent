import { logger } from "../../logger.js";
import type { Tool } from "../../types.js";

const OWM_API_KEY = "d3f9628635d37bcaad44511d9d5f8762";
const OWM_BASE = "https://api.openweathermap.org/data/2.5";

function owmLang(lang: string): string {
  if (lang.startsWith("zh")) return "zh_tw";
  return lang.split("-")[0];
}

async function fetchWithRetry(url: string): Promise<Response> {
  try {
    const res = await fetch(url);
    if (res.ok) return res;
    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    logger.warn({ err }, "OWM fetch failed, retrying in 2s");
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} on retry`);
    return res;
  }
}

interface OWMCurrent {
  weather: { description: string }[];
  main: {
    temp: number;
    feels_like: number;
    humidity: number;
  };
  wind: { speed: number };
  name: string;
}

interface OWMForecastItem {
  dt: number;
  dt_txt: string;
  main: {
    temp: number;
    temp_min: number;
    temp_max: number;
    humidity: number;
  };
  weather: { description: string }[];
  pop: number; // probability of precipitation 0-1
}

interface OWMForecastResponse {
  list: OWMForecastItem[];
}

export const weather: Tool = {
  name: "get_weather",
  description:
    "Get weather for a city. Returns current temperature, feels-like, description, rain chance, and 3-day forecast.",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "City name, e.g. Taipei, Tokyo, London" },
      lang: { type: "string", description: "Language code (default: zh-tw)" },
    },
    required: ["city"],
  },
  execute: async (args) => {
    const { city, lang = "zh-tw" } = args as { city: string; lang?: string };
    const ol = owmLang(lang);

    logger.info({ city, lang }, "weather query (OpenWeatherMap)");

    try {
      // Current weather
      const curUrl = `${OWM_BASE}/weather?q=${encodeURIComponent(city)}&appid=${OWM_API_KEY}&units=metric&lang=${ol}`;
      const curRes = await fetchWithRetry(curUrl);
      const cur = (await curRes.json()) as OWMCurrent;

      // 5-day / 3-hour forecast (we only use first 3 days = 24 entries)
      const fcUrl = `${OWM_BASE}/forecast?q=${encodeURIComponent(city)}&appid=${OWM_API_KEY}&units=metric&lang=${ol}&cnt=24`;
      const fcRes = await fetchWithRetry(fcUrl);
      const fc = (await fcRes.json()) as OWMForecastResponse;

      // Group forecast by date
      const dayMap = new Map<string, OWMForecastItem[]>();
      for (const item of fc.list) {
        const date = item.dt_txt.split(" ")[0];
        if (!dayMap.has(date)) dayMap.set(date, []);
        dayMap.get(date)!.push(item);
      }

      const forecast = [...dayMap.entries()].slice(0, 3).map(([date, items]) => {
        const maxT = Math.max(...items.map((i) => i.main.temp_max));
        const minT = Math.min(...items.map((i) => i.main.temp_min));

        // Pick representative periods: morning (~06-09), afternoon (~12-15), evening (~18-21)
        const pick = (startH: number, endH: number, name: string) => {
          const matched = items.filter((i) => {
            const h = parseInt(i.dt_txt.split(" ")[1].split(":")[0], 10);
            return h >= startH && h <= endH;
          });
          const rep = matched[0];
          if (!rep) return null;
          return {
            name,
            temp_C: String(Math.round(rep.main.temp * 10) / 10),
            description: rep.weather[0]?.description ?? "",
            chance_of_rain: String(Math.round(rep.pop * 100)),
          };
        };

        const periods = [
          pick(6, 9, "早上"),
          pick(12, 15, "中午"),
          pick(18, 21, "晚上"),
        ].filter(Boolean);

        return {
          date,
          max_C: String(Math.round(maxT * 10) / 10),
          min_C: String(Math.round(minT * 10) / 10),
          periods,
        };
      });

      const result = {
        city: cur.name,
        current: {
          temp_C: String(cur.main.temp),
          feels_like_C: String(cur.main.feels_like),
          description: cur.weather[0]?.description ?? "",
          humidity: String(cur.main.humidity),
          wind_kmph: String(Math.round(cur.wind.speed * 3.6 * 10) / 10),
        },
        forecast,
      };

      return JSON.stringify(result, null, 2);
    } catch (err) {
      logger.error({ err, city }, "weather query failed");
      return `Query failed: ${(err as Error).message}`;
    }
  },
};
