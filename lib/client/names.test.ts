import { describe, expect, it } from "vitest";
import { airlineName, identityOf, isAirlineCallsign, routeFits, type Route } from "./names";

const paris = { city: "Paris", code: "CDG", lat: 49.0097, lon: 2.5479 };
const nice = { city: "Nice", code: "NCE", lat: 43.6584, lon: 7.2159 };
const route: Route = { airline: "Air France", flight: "AF7700", from: paris, to: nice };

describe("names", () => {
  it("tells airline callsigns from registrations", () => {
    expect(isAirlineCallsign("EJU4586")).toBe(true);
    expect(isAirlineCallsign("AFR12KP")).toBe(true);
    expect(isAirlineCallsign("FGDEM")).toBe(false);
    expect(isAirlineCallsign("N123AB")).toBe(false);
    expect(isAirlineCallsign(undefined)).toBe(false);
  });

  it("keeps a route only where the aircraft could be on it", () => {
    expect(routeFits(route, { lat: 46.5, lon: 4.8 })).toBe(true);
    expect(routeFits(route, { lat: 48.9, lon: 2.4 })).toBe(true);
    expect(routeFits(route, { lat: 51.5, lon: -0.1 })).toBe(false);
  });

  it("shortens airline names the way people say them", () => {
    expect(airlineName("Scandinavian Airlines System")).toBe("Scandinavian");
    expect(airlineName("easyJet Europe")).toBe("easyJet Europe");
  });

  it("names an airliner by its flight, a light aircraft by its model, else by its callsign", () => {
    expect(identityOf({ hex: "39ab12", callsign: "AFR7700", type: "A320" }, null, route)).toEqual({ title: "Air France AF7700", detail: "Airbus A320", route });
    expect(identityOf({ hex: "39ab13", callsign: "FGDEM", registration: "F-GDEM", type: "C172" }, { model: "Cessna 172S", owner: "Aeroclub de Toussus", registration: "F-GDEM" }, null)).toEqual({
      title: "Cessna 172 Skyhawk",
      detail: "F-GDEM, Aeroclub de Toussus",
      route: null,
    });
    expect(identityOf({ hex: "4ca7d2", callsign: "RYR88TK", type: "B738" }, null, null).title).toBe("RYR88TK");
  });
});
