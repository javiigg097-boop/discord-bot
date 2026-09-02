# FiveM Discord Control

Bot para Discord que permite registrar manualmente jugadores por bandos
(Mafia, Policía, Admins, EMS, etc.) y comprobar cuáles aparecen en la lista
pública de un servidor FiveM.

## Qué hace

- `/bando crear` crea bandos.
- `/registrar` añade jugadores manualmente.
- `/estado` muestra cuántos registrados de cada bando están online.
- `/jugador` muestra el estado y las horas registradas.
- `/lista` lista jugadores registrados.
- `/panel` publica/actualiza un panel permanente.
- `/forzar_actualizacion` consulta FiveM inmediatamente.
- Guarda sesiones y horas desde el momento en que el bot empieza a observarlas.

## Importante

Las horas son **observadas por este bot**, no necesariamente el tiempo real
histórico del jugador en FiveM. Si el servidor deja de exponer nombres públicos,
el bot no podrá asociar jugadores por nombre.

El bot intenta primero:
`https://servers-frontend.fivem.net/api/servers/single/<CODIGO>`

La estructura de la respuesta puede cambiar con el tiempo; la función
`extractPlayers()` está aislada para poder adaptarla fácilmente.

## Instalación

1. Instala Node.js 20 o superior.
2. Abre una terminal dentro de esta carpeta.
3. Ejecuta:

```bash
npm install
```

4. Copia `.env.example` como `.env`.
5. Rellena:
   - `DISCORD_TOKEN`
   - `CLIENT_ID`
   - `GUILD_ID`
   - `OWNER_ID`

6. En el portal de Discord crea un bot e invítalo con los scopes:
   - `bot`
   - `applications.commands`

7. Ejecuta:

```bash
npm start
```

Los comandos pueden tardar unos segundos en aparecer la primera vez.

## Ejemplos

Crear grupos:

```text
/bando crear nombre:Mafia emoji:🔴
/bando crear nombre:Policía emoji:🔵
/bando crear nombre:Admins emoji:🟡
```

Registrar jugadores:

```text
/registrar nombre:Strawberry Banana bando:Mafia rango:BIG BOSS
/registrar nombre:Nombre Policía bando:Policía rango:Agente
```

Panel:

```text
/config canal_estado
/panel
```

## Datos

Los datos se guardan localmente en:

```text
data/data.json
```

Haz copias de seguridad de esa carpeta si vas a mover el bot.


## V2

Ahora incluye dos paneles:

- **Panel Mafia**: miembros, online/offline y ranking semanal por horas observadas.
- **Panel General**: 10 slots de mafias y el resto de bandos (Policía, EMS, Staff, etc.).

Configura cada canal con:

```text
/config canal_mafia
/config canal_estado
```

Después usa `/panel tipo:Mafia`, `/panel tipo:General` o `/panel tipo:Ambos`.

Para las 10 mafias, crea bandos llamados por ejemplo: `Mafia 1`, `Mafia 2`, ..., `Mafia 10`.


## Alertas V3

Configura un canal con `/config canal_alertas`.

El bot avisa **una sola vez** cuando detecta entre **2 y 5 policías online**. La alerta se rearma cuando el número sale de ese rango, evitando spam.

## Railway

Para Railway configura las variables de entorno directamente en el panel. Para conservar `data/data.json` entre redeploys, crea un Volume y móntalo en `/app/data` (o ajusta el código para usar una base de datos gestionada). Para máxima simplicidad inicial puedes probar sin volumen, pero un redeploy puede perder datos locales.
