"""uvicorn 入口：control.main:app。"""

from .app import create_app
from .settings import Settings

app = create_app(Settings.from_env())
