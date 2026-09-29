// Five saved NYC places, as Someday's save_place would have written them: the entry id, the
// place object's fields, the tags, and when it was saved. dev-server/server.mjs turns them into
// wire_search matches.

export const SAMPLE_PLACES = [
  {
    id: "3f2b8c1e-5a4d-4e7b-9c10-1a2b3c4d5e01",
    fields: { name: "Joe's Pizza", address: "7 Carmine St, New York, NY 10014", lat: 40.73055, lng: -74.00214, locality: "New York", region: "New York", country: "United States" },
    tags: ["pizza", "cheap eats", "late night"],
    ingestedAt: "2026-06-14T19:22:05.000Z",
  },
  {
    id: "3f2b8c1e-5a4d-4e7b-9c10-1a2b3c4d5e02",
    fields: { name: "Russ & Daughters", address: "179 E Houston St, New York, NY 10002", lat: 40.72262, lng: -73.98820, locality: "New York", region: "New York", country: "United States" },
    tags: ["bagels", "smoked fish", "brunch"],
    ingestedAt: "2026-07-02T13:10:44.000Z",
  },
  {
    id: "3f2b8c1e-5a4d-4e7b-9c10-1a2b3c4d5e03",
    fields: { name: "Smalls Jazz Club", address: "183 W 10th St, New York, NY 10014", lat: 40.73446, lng: -74.00266, locality: "New York", region: "New York", country: "United States" },
    tags: ["jazz", "live music", "late night"],
    ingestedAt: "2026-08-21T23:51:12.000Z",
  },
  {
    id: "3f2b8c1e-5a4d-4e7b-9c10-1a2b3c4d5e04",
    fields: { name: "Brooklyn Bridge Park, Pier 1", address: "Furman St & Old Fulton St, Brooklyn, NY 11201", lat: 40.70215, lng: -73.99671, locality: "Brooklyn", region: "New York", country: "United States" },
    tags: ["park", "views", "sunset"],
    ingestedAt: "2026-05-30T18:03:27.000Z",
  },
  {
    id: "3f2b8c1e-5a4d-4e7b-9c10-1a2b3c4d5e05",
    fields: { name: "The Met Cloisters", address: "99 Margaret Corbin Dr, New York, NY 10040", lat: 40.86489, lng: -73.93175, locality: "New York", region: "New York", country: "United States" },
    tags: ["museum", "gardens", "medieval art"],
    ingestedAt: "2026-09-03T15:37:58.000Z",
  },
];
