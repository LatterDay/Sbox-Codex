# Genetics / Breeding (heritable, mutating procedural variation)

Cross two "parents" into a child that **inherits** their stats with controlled randomness, occasionally **mutates** a rare trait, carries a **generation** count that tightens variance over inbred lines, and earns a stable **hash identity** so a best-of registry can track unique strains. The canonical use is a cultivation/breeding tycoon, but the same machine fits any game where things have heritable variation: animal/monster breeding, roguelite item lineages, or a graveyard's haunting/contract/soul traits.

## What it IS and when you need it

Four parts, almost always shipped together:

1. **An immutable genome** — a value struct holding the heritable numeric stats + a few categorical/visual traits. Immutable so a bred genome can't be edited after the fact (anti-cheat + clean equality).
2. **A cross function** — `child = Cross(parentA, parentB)`: each stat is a Gaussian sample around the parents' mean; rare mutations fire; the child's generation is `max(parents)+1`.
3. **A variance schedule** — variance shrinks as generation climbs (selfing/IBL "stabilizes" a line), so deep breeding converges and shallow crosses stay wild.
4. **A hash identity + best-of registry** — a deterministic hash buckets genomes by lineage+mutation so the game can rank "the best Purple Wedding-Cake anyone has bred" without storing every individual.

Reach for it whenever the *fun* is in combining and selecting variation over generations rather than buying a fixed catalog. If your variation is purely cosmetic and non-heritable, you want a simple weighted roll (`gacha-loot.md`), not this.

## Canonical approach

### 1. The immutable genome struct

Hold heritable stats as plain floats on a `struct` (value semantics, cheap to copy, can't be mutated in place). Add categorical traits (species, autoflower), a couple of visual ones (leaf colour), lineage labels, the generation counter, and the hash. Equality is by hash.

```csharp
public struct StrainGenome : IEquatable<StrainGenome>
{
    // heritable numerics
    public float ThcPercent, CbdPercent, TerpenePercent;
    public float YieldGramsBase, FlowerTimeMultiplier, HeightCm;
    public float PestResistance, MoldResistance, HeatTolerance;     // 0..1

    // categorical / visual (mutations)
    public Species Species; public Color LeafColor; public bool IsAutoflower;

    // lineage
    public int Generation;          // 0 = original, 1 = F1, ...
    public bool IsStabilizedIbl;    // true from F8 if stable
    public string Lineage, PhenoLabel, MutationType, GenomeHash;

    // ranking formula for the best-of registry
    public float CombinedScore => ThcPercent * 2f + YieldGramsBase * 0.1f + TerpenePercent * 5f;

    public bool Equals( StrainGenome o ) => GenomeHash == o.GenomeHash;
    public override int GetHashCode() => GenomeHash?.GetHashCode() ?? 0;
}
```

Verified against klibatocorp.phenodex `Code/Cultivation/StrainGenome.cs` (struct + heritable fields `:15-63`, `CombinedScore` ranking `:60`, hash-based equality `:65-67`, and a library of `static` starter strains `:73+`). Keep starter strains as `static` factory methods so the shop has a known, stabilized (`IsStabilizedIbl = true`, `Generation = 0`) base set to breed from.

### 2. The cross — Gaussian inheritance around the parents' mean

Each child stat is a Gaussian draw centred on `(a + b) / 2` whose spread grows with how *far apart* the parents are (close parents → tight child; distant parents → wild child), then clamped to the trait's valid range. The child's generation is one past the deeper parent.

```csharp
public static BreedingResult Cross( StrainGenome a, StrainGenome b )
{
    var rng = Random.Shared;                                  // swap for a server seed to make it reproducible
    int childGen = Math.Max( a.Generation, b.Generation ) + 1;       // System.Math, not MathF (absent in sandbox)
    float varianceMult = Math.Max( 0.20f, 1f - childGen * 0.10f );  // F1=100% … F8=30% … floor 20%

    var child = new StrainGenome {
        ThcPercent     = Sample( rng, a.ThcPercent,     b.ThcPercent,     1f,  35f,   varianceMult ),
        YieldGramsBase = Sample( rng, a.YieldGramsBase, b.YieldGramsBase, 40f, 1000f, varianceMult ),
        // ...every heritable stat the same way...
        LeafColor   = LerpColor( a.LeafColor, b.LeafColor, (float)rng.NextDouble() ),
        Generation  = childGen,
        IsStabilizedIbl = childGen >= 8,
    };

    if ( rng.NextDouble() < 0.05 ) child = ApplyMutation( rng, child );   // rare (~5%) trait spike / rare colour
    child.GenomeHash = ComputeGenomeHash( child );
    return new BreedingResult { Child = child /* + a label for the toast */ };
}

// child stat = clamp( gauss( mean=(a+b)/2, stddev=(|a-b|*0.5 + mean*0.06) * varianceMult ), min, max )
static float Sample( Random rng, float a, float b, float min, float max, float varianceMult )
{
    float mean = (a + b) * 0.5f;
    float stddev = ( Math.Abs( a - b ) * 0.5f + Math.Abs( mean ) * 0.06f ) * varianceMult;
    return Math.Clamp( (float)(mean + GaussZ( rng ) * stddev), min, max );   // System.Math (MathF absent in sandbox)
}

// Box-Muller standard-normal draw
static double GaussZ( Random rng )
{
    double u1 = rng.NextDouble(), u2 = rng.NextDouble();
    return Math.Sqrt( -2.0 * Math.Log( u1 ) ) * Math.Cos( 2.0 * Math.PI * u2 );
}
```

Verified against klibatocorp.phenodex `Code/Cultivation/Breeding.cs`: `childGen = max(a,b)+1` and `varianceMult = max(0.20, 1 - childGen*0.10)` (`:46-47`), per-stat `Sample(...)` with explicit min/max ranges (`:53-61`), the `stddev = (|a-b|*0.5 + mean*0.06) * varianceMult` formula (`:97-101`), Box-Muller `GaussZ` (`:108`), `LerpColor` for visual traits (`:63,:132`), the `IsStabilizedIbl = childGen >= 8` flag (`:69`), and the rare-mutation branch (`:74-77`, `ApplyMutation :115`). The small `mean * 0.06` floor on stddev keeps even identical parents from producing perfect clones.

### 3. Hash identity + best-of registry

The hash must bucket by what makes a strain *categorically* distinct (lineage + mutation + a couple of categoricals), NOT by the continuously-varying stats — otherwise every cross is a new bucket and the registry explodes. The varying stats instead feed the **best-of** comparison inside a bucket.

```csharp
public static string ComputeGenomeHash( StrainGenome g ) =>
    HashCode.Combine( g.Lineage?.GetHashCode() ?? 0,
                      g.MutationType?.GetHashCode() ?? 0,
                      g.IsAutoflower, g.Species ).ToString();

// registry keeps only the highest CombinedScore per bucket
void Submit( StrainGenome g )
{
    if ( !_best.TryGetValue( g.GenomeHash, out var cur ) || g.CombinedScore > cur.CombinedScore )
        _best[g.GenomeHash] = g;
}
```

Verified against phenodex `Code/Cultivation/StrainGenome.cs` `ComputeGenomeHash` buckets by `(Lineage, MutationType, IsAutoflower, Species)` (`:149-153`) with the stat variance deliberately *not* part of the bucket (`:146` comment), and `BredStrainRegistry.cs` / `StrainLeaderboard.cs` track best-of-bucket. A `ProceduralNamer.cs` gives each new lineage a generated name so bred strains read as distinct discoveries.

## Notable variations

- **Server-seeded reproducibility.** Swap `Random.Shared` for a host-owned seeded `Random` so a cross is deterministic and replayable across the network (and provably-fair if you commit-reveal the seed — see `anti-cheat.md`). phenodex notes this as the intended upgrade path (`Breeding.cs:20`).
- **Generation-driven stabilization as a goal.** The `varianceMult` shrink turns "stabilize my line to F8" into a real grind: early crosses are lottery, late selfing is precision. Surface `Generation`/`IsStabilizedIbl` in the UI so the player feels the convergence.
- **Mutation as a separate bucket.** Because the hash includes `MutationType`, a rare Purple/Frosty/Foxtail phenotype lands in its *own* registry bucket — so "best Purple Gelato" and "best standard Gelato" are tracked separately. This is what makes rare mutations feel collectible.
- **Map onto non-plant domains.** The exact machine fits monster/animal breeding (stats + rare colour morphs), roguelite gear lineages, or — for a graveyard tycoon — a haunting/soul "genome" where contracts inherit + mutate traits across generations. Only the stat names and ranges change.

## Gotchas

- **A `struct` genome is copied by value** — `Cross` returns a *new* genome; never mutate a parent in place. Good (immutability = anti-cheat), but watch for accidental copies in collections (box on interface casts).
- **Hash on continuous stats explodes the registry.** Bucket by categoricals only; rank by a `CombinedScore`. Mixing the two is the #1 design error here.
- **Clamp every sampled stat to its real range** or a wild Gaussian draw produces negative THC / 0-yield monsters. Each `Sample` carries explicit `min/max`.
- **`Random.Shared` is non-deterministic and not host-authoritative.** Fine for a solo/cosmetic breed; for a competitive leaderboard, seed it server-side and validate the submitted genome on the host (don't trust a client-computed `CombinedScore`).
- **Don't let a stddev floor of 0 clone parents.** The `+ mean * 0.06` term guarantees a little spread even when `a == b`, so selfing still drifts.

## Seen in

- **klibatocorp.phenodex** — `Code/Cultivation/StrainGenome.cs` (immutable genome + `CombinedScore` + hash bucket + starter library), `Breeding.cs` (Gaussian `Cross`, variance-by-generation, rare mutation), `BredStrainRegistry.cs` / `StrainLeaderboard.cs` (best-of-bucket), `ProceduralNamer.cs` (lineage names).
- **thefancylads.farm_land** — `Code/Crop.cs` / `CropMutationRegistry.cs` (lighter "rare variant on harvest" mutation registry, no full genome) — the simpler cousin when you only need rare drops, not heritable lineages.

Open the cited file under `C:/Users/cargi/sbox-lessons/zips-code/<game>/` to read the real implementation.

---
**Verify live:** this system is plain C# (`struct`, `System.Random`, `HashCode.Combine`, `System.Math`) with almost no engine surface, so it's the most SDK-stable recipe here. The source uses **`System.Math`** (`Math.Max`/`Abs`/`Clamp`/`Sqrt`/`Log`/`Cos`) — note **`System.MathF` does NOT exist** in the s&box sandbox, so prefer `System.Math` or `MathX` for any extra helpers. Confirm `Color.Lerp` against the installed SDK (`describe_type Color`, `search_types MathX`). Reflection over memory.

**See also:** `progression-upgrades.md` (data-driven balance tables for the stat ranges), `gacha-loot.md` (weighted rolls when variation is non-heritable), and `anti-cheat.md` (seeded/provably-fair RNG + host-side validation of a submitted genome).
