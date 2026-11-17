- Effective-config resolution now preserves an own enumerable `__proto__` key
  in effective and provenance maps, including when serializing reports. It does
  not mutate their prototypes.
