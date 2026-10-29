---
name: secret-from-operator
description: Získa od operátora tajomstvo (heslo pre aplikáciu, heslo k účtu, kód dvojfázového overenia, klient OAuth, adresu z prehliadača) tak, aby neprešlo prepisom vlákna T3 ani databázou T3. Použi vždy, keď agent alebo služba potrebuje od operátora hodnotu, ktorá sa nesmie ocitnúť v chate.
scripts: none
scripts-reason: Skill volá skript secret_drop.sh z koreňa repa, vlastný skript v skille nemá.
---

# Tajomstvo od operátora

Nikdy ho nežiadaj v chate ani nástrojom `request_secret` z T3. Ten drží hodnotu
v úložisku tajomstiev T3 a vráti ju ako `secretRef` pre nástroje T3, alebo od
v0.1.3 s `delivery: "file"` ju presunie do súboru 600 pod
`/root/.t3/userdata/secrets/files/`, ktorý T3 po 24 hodinách zmaže (PR 24809).
Hodnota tak prejde aplikáciou a úložiskom T3 a súbor volí T3, nie operátor
(`RULES.md` §6), preto cesta ostáva `secret_drop.sh`.

Skript `secret_drop.sh` v koreni repa spustí na pár minút jednorazovú stránku na
`https://<host tailnetu>:8804/s/<token>` (tailnet, TLS od Tailscale).
Operátor ju otvorí vo svojom prehliadači, hodnotu vloží do poľa a stránka ju zapíše
do súboru 600 pod používateľom agenta. Po uložení všetkých polí server skončí
a `tailscale serve` cestu zruší. Hodnota nejde do výpisu, argumentov ani logu.
Voľby sú v `README.md` repa, časť "Tajomstvo od operátora".

## Postup

1. Spusti na pozadí (`run_in_background`) z koreňa repa:

   ```
   ./secret_drop.sh --user <používateľ agenta> --dir <home agenta>/.config/<agent> --serve \
     --field icloud-app-password:secret:"Heslo pre aplikáciu" [--field ...] [--ttl 900]
   ```

   Osobný asistent môže mať hotové sady polí vo svojom repe.
2. Prvý riadok výstupu je odkaz. Pošli ho operátorovi s jednou vetou, čo má vložiť
   a odkiaľ to vziať.
3. Výsledok nečítaj od operátora, súbor sa objaví sám. Skript skončí kódom 0
   (`{"saved":[...]}`), alebo 3 po vypršaní času. Pri 3 pošli nový odkaz.

Druhy polí: `secret` (heslo, skryté), `text` (kód, viditeľný), `textarea`
(viac riadkov), `json` (musí byť platný objekt). Priečinok musí patriť používateľovi
a mať práva 700, skript ho nevytvára.

## Pravidlá

- Súbor patrí agentovi, nie rootovi. Skript to vynúti.
- Port 8804 je jediná cesta, ktorú skript pridáva do `tailscale serve`. Dve stránky
  naraz nespúšťaj.
- Server sám nepreloží meno tailnetu (`getent hosts <host tailnetu>` zlyhá),
  operátorovi odkaz funguje. Zo servera ho skúšaj cez
  `curl --resolve <host tailnetu>:8804:<ip servera z tailscale status>`.
- Odkaz platí do uloženia alebo do vypršania. Po tom je neplatný, v prepise ostáva bez škody.
