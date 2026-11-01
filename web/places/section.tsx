import { useMutation, useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { request } from "../app/api.ts";
import { queryClient } from "../app/query.ts";
import type { Place } from "../app/types.ts";
import {
  Button,
  Dialog,
  Select,
  SettingsCard,
  SettingsRow,
  Switch,
  TextField,
} from "../ui/components.tsx";
import { showError, showToast } from "../ui/toast.tsx";
import { useMe } from "../workspaces/data.ts";
import type { Pin } from "./map.tsx";

const PlaceMap = lazy(() => import("./map.tsx"));

/** The radii a person picks, in meters: iOS does not see a circle under 100 m reliably, and a cottage needs more. */
const RADII = [100, 200, 300, 500, 1000, 2000];
const DEFAULT_RADIUS = 200;

type PlaceInput = Pick<
  Place,
  "name" | "latitude" | "longitude" | "radius" | "shared"
>;

/**
 * The person's own places, which they mark with a pin on a map and share with every member's turns or keep private,
 * and the ones other members shared. A reminder waits for a person to arrive at one or leave it.
 */
export function PlacesSection({ workspaceId }: { workspaceId: string }) {
  const { user } = useMe();
  const base = `/workspaces/${workspaceId}/places`;
  const queryKey = ["workspaces", workspaceId, "places"];
  const [editing, setEditing] = useState<Place | "new" | null>(null);
  const { data } = useQuery({
    queryKey,
    queryFn: ({ signal }) => request<{ places: Place[] }>(base, { signal }),
  });
  const save = useMutation({
    mutationFn: (input: { placeId: string | null; place: PlaceInput }) =>
      request<Place>(input.placeId ? `${base}/${input.placeId}` : base, {
        method: input.placeId ? "PUT" : "POST",
        body: input.place,
      }),
    onSuccess: () => {
      setEditing(null);
      return queryClient.invalidateQueries({ queryKey });
    },
    onError: showError,
  });
  const remove = useMutation({
    mutationFn: (placeId: string) =>
      request(`${base}/${placeId}`, { method: "DELETE" }),
    onSuccess: () => {
      showToast("success", "Place removed");
      return queryClient.invalidateQueries({ queryKey });
    },
    onError: showError,
  });
  return (
    <>
      <SettingsCard>
        {data?.places.map((place) =>
          place.ownerId === user.id ? (
            <SettingsRow
              compact
              description={`${place.radius} m · ${place.shared ? "Shared" : "Private"}`}
              key={place.id}
              label={place.name}
            >
              <Switch
                checked={!place.shared}
                label="Private"
                onChange={(checked) =>
                  save.mutate({
                    placeId: place.id,
                    place: { ...place, shared: !checked },
                  })
                }
              />
              <Button
                icon="compose"
                label={`Change ${place.name}`}
                onClick={() => setEditing(place)}
                size="icon"
                variant="ghost"
              />
              <Button
                icon="trash"
                label={`Remove ${place.name}`}
                onClick={() => remove.mutate(place.id)}
                size="icon"
                variant="ghost"
              />
            </SettingsRow>
          ) : (
            <SettingsRow
              compact
              description={`${place.radius} m · Shared by ${place.ownerName}`}
              key={place.id}
              label={place.name}
            />
          )
        )}
        <div className="settings-row compact">
          <Button
            icon="plus"
            label="Add place"
            onClick={() => setEditing("new")}
            size="small"
          />
        </div>
      </SettingsCard>
      <PlaceDialog
        busy={save.isPending}
        // A new key for each place, so the dialog starts from it.
        key={typeof editing === "string" ? editing : (editing?.id ?? "")}
        onClose={() => setEditing(null)}
        onSave={(place) =>
          save.mutate({
            placeId: editing === "new" ? null : (editing?.id ?? null),
            place,
          })
        }
        place={editing}
      />
    </>
  );
}

/** Adds a place or changes one: its name, its pin on the map, and the radius of its circle. */
function PlaceDialog({
  place,
  busy,
  onClose,
  onSave,
}: {
  place: Place | "new" | null;
  busy: boolean;
  onClose: () => void;
  onSave: (place: PlaceInput) => void;
}) {
  const existing = place === "new" ? null : place;
  const [pin, setPin] = useState<Pin | null>(existing);
  const [radius, setRadius] = useState(existing?.radius ?? DEFAULT_RADIUS);
  return (
    <Dialog
      busy={busy}
      onClose={onClose}
      onSubmit={(form) => {
        if (!pin) {
          showToast("error", "Put the pin on the map");
          return;
        }
        onSave({
          name: String(form.get("name")),
          latitude: pin.latitude,
          longitude: pin.longitude,
          radius,
          shared: existing?.shared ?? false,
        });
      }}
      open={place !== null}
      submit={existing ? "Save" : "Add place"}
      title={existing ? existing.name : "Add a place"}
    >
      <TextField
        autoComplete="off"
        defaultValue={existing?.name}
        label="Name"
        name="name"
        required
      />
      <Suspense fallback={<div className="place-map" />}>
        <PlaceMap onPin={setPin} pin={pin} radius={radius} />
      </Suspense>
      <div className="field">
        Radius
        <Select
          label="Radius"
          onChange={(value) => setRadius(Number(value))}
          options={RADII.map((meters) => ({
            value: String(meters),
            label: meters < 1000 ? `${meters} m` : `${meters / 1000} km`,
          }))}
          value={String(radius)}
        />
      </div>
    </Dialog>
  );
}
