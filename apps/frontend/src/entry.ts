import './styles.css'
import { Runtime } from 'foldkit'
import { Model } from './app/model'
import { init, update } from './app/update'
import { view } from './app/view'

const program = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  container: document.getElementById('root'),
})

Runtime.run(program)
